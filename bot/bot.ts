import { Client, Options, VoiceChannel } from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  VoiceConnection,
} from "@discordjs/voice";
import { drive_v3 } from "googleapis/build/src/apis/drive/v3";
import { GoogleAuth } from "google-auth-library";
import cron from "node-cron";
import { PassThrough } from "stream";
import express from "express";
import { config } from "dotenv";

interface Track {
  id: string;
  name: string;
}

const client = new Client({
  intents: ["Guilds", "GuildVoiceStates"],
  makeCache: Options.cacheWithLimits({
    MessageManager: 0,
    PresenceManager: 0,
    GuildMemberManager: 0,
  }),
});
config();

const player = createAudioPlayer();
const folderId = "16D-5og0WS7PYBxb1raeH0-rc1MzlQ-sF";

const auth = new GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS || "{}"),
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
});
const drive = new drive_v3.Drive({ auth });

// HTTP-server for pinging
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => {
  res.send("Bot is alive!");
});
app.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
});

async function getFilesFromFolder(): Promise<Track[]> {
  try {
    const res = await drive.files.list({
      q: `'${folderId}' in parents`,
      fields: "files(id,name)",
    });
    const files = (res.data.files || []).filter(
      (file) => file.id && file.name
    ) as { id: string; name: string }[];
    console.log(`Found files: ${files.length}`);
    return files.map((file) => ({ id: file.id, name: file.name }));
  } catch (error: any) {
    console.error("Google Drive API error:", error.message);
    return [];
  }
}

async function getRandomTracks(count: number): Promise<Track[]> {
  const allTracks = await getFilesFromFolder();
  if (allTracks.length <= count) return allTracks;
  return allTracks.sort(() => 0.5 - Math.random()).slice(0, count);
}

let connection: VoiceConnection;
let dailyQueue: Track[] = [];
let index = 0;

async function playNext(): Promise<void> {
  console.log("Starting playNext function...");
  if (index >= dailyQueue.length) {
    console.log("Daily queue completed.");
    return;
  }

  const track = dailyQueue[index];
  console.log(`Now playing: ${track.name} (ID: ${track.id})`);

  const cleanTrackName = track.name.replace(/\.mp3$/, "").trimEnd();
  const newChannelName = `Tempo.Radio | Now playing: ${cleanTrackName}`.slice(
    0,
    100
  );
  const channel = connection?.joinConfig.channelId
    ? (client.channels.cache.get(
        connection.joinConfig.channelId
      ) as VoiceChannel)
    : null;
  if (channel) {
    try {
      console.log("Attempting to update channel name...");
      await channel.setName(newChannelName);
      console.log(`Channel name updated: ${newChannelName}`);
    } catch (error: any) {
      console.error("Error updating channel name:", error.message);
    }
  }

  try {
    console.log("Fetching stream from Google Drive...");
    const response = await drive.files.get(
      { fileId: track.id, alt: "media" },
      { responseType: "stream" }
    );
    console.log("Stream received from Google Drive");
    const inputStream = response.data;

    console.log("Creating buffer stream...");
    const bufferStream = new PassThrough({ highWaterMark: 1024 * 1024 });
    inputStream.pipe(bufferStream);
    console.log("Stream piped to buffer");

    console.log("Creating audio resource...");
    const resource = createAudioResource(bufferStream, {
      inlineVolume: true,
      inputType: StreamType.Arbitrary,
    });
    console.log("Audio resource created");
    if (resource.volume) {
      resource.volume.setVolume(1.0);
      console.log("Volume set to 1.0");
    }

    if (!connection || connection.state.status === "disconnected") {
      console.log("No active connection, joining voice channel...");
      const channel = client.channels.cache.get(
        "1344225046549368879"
      ) as VoiceChannel;
      if (!channel) throw new Error("Канал не найден");
      connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfMute: false,
        selfDeaf: false,
      });
      console.log("Voice channel joined");
    }

    console.log("Subscribing player to connection...");
    const subscription = connection.subscribe(player);
    if (!subscription) throw new Error("Ошибка подписки");
    console.log("Player subscribed");

    console.log("Starting playback...");
    player.play(resource);
    console.log("Воспроизведение начато");
  } catch (error: any) {
    console.error("Ошибка воспроизведения:", error.message);
    index++;
    return playNext();
  }

  player.once(AudioPlayerStatus.Idle, () => {
    console.log("Трек завершён");
    if (global.gc) global.gc();
    index++;
    playNext();
  });
}

async function playMusic(channel: VoiceChannel): Promise<void> {
  connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfMute: false,
    selfDeaf: false,
  });

  // Ожидание готовности соединения
  await new Promise<void>((resolve) => {
    connection.on("stateChange", (oldState, newState) => {
      console.log(`Состояние соединения: ${newState.status}`);
      if (newState.status === "ready") resolve();
    });
  });

  // Обработчик disconnect
  connection.on("stateChange", async (oldState, newState) => {
    if (newState.status === "disconnected") {
      console.log("Соединение разорвано, перезапускаем воспроизведение...");
      try {
        // Уничтожаем старое соединение, если оно ещё существует
        if (connection) {
          connection.destroy();
        }
        // Перезапускаем воспроизведение
        const channel = client.channels.cache.get(
          "1344225046549368879"
        ) as VoiceChannel;
        if (channel) {
          await playMusic(channel);
        } else {
          console.error("Канал не найден для переподключения");
        }
      } catch (error) {
        console.error("Ошибка при переподключении:", error);
      }
    }
  });

  dailyQueue = await getRandomTracks(20);
  index = 0;
  await playNext();

  cron.schedule("0 4 * * *", async () => {
    console.log("Обновление очереди в 4 утра...");
    dailyQueue = await getRandomTracks(20);
    index = 0;
    await playNext();
  });
}

client.once("ready", () => {
  console.log("Bot is ready!");
  const channel = client.channels.cache.get(
    "1344225046549368879"
  ) as VoiceChannel;
  if (!channel) console.log("Канал не найден!");
  else playMusic(channel);
});

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
client.login(DISCORD_TOKEN).catch((error) => {
  console.error("Ошибка входа:", error);
});
