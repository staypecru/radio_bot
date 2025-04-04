"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const voice_1 = require("@discordjs/voice");
const v3_1 = require("googleapis/build/src/apis/drive/v3");
const google_auth_library_1 = require("google-auth-library");
const node_cron_1 = __importDefault(require("node-cron"));
const stream_1 = require("stream");
const express_1 = __importDefault(require("express"));
const dotenv_1 = require("dotenv");
const client = new discord_js_1.Client({
    intents: ["Guilds", "GuildVoiceStates"],
    makeCache: discord_js_1.Options.cacheWithLimits({
        MessageManager: 0,
        PresenceManager: 0,
        GuildMemberManager: 0,
    }),
});
(0, dotenv_1.config)();
const player = (0, voice_1.createAudioPlayer)();
const folderId = "16D-5og0WS7PYBxb1raeH0-rc1MzlQ-sF";
const auth = new google_auth_library_1.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS || "{}"),
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
});
const drive = new v3_1.drive_v3.Drive({ auth });
// HTTP-server for pinging
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => {
    res.send("Bot is alive!");
});
app.listen(PORT, () => {
    console.log(`HTTP server running on port ${PORT}`);
});
async function getFilesFromFolder() {
    try {
        const res = await drive.files.list({
            q: `'${folderId}' in parents`,
            fields: "files(id,name)",
        });
        const files = (res.data.files || []).filter((file) => file.id && file.name);
        console.log(`Found files: ${files.length}`);
        return files.map((file) => ({ id: file.id, name: file.name }));
    }
    catch (error) {
        console.error("Google Drive API error:", error.message);
        return [];
    }
}
async function getRandomTracks(count) {
    const allTracks = await getFilesFromFolder();
    if (allTracks.length <= count)
        return allTracks;
    return allTracks.sort(() => 0.5 - Math.random()).slice(0, count);
}
let connection;
let dailyQueue = [];
let index = 0;
async function playNext() {
    if (index >= dailyQueue.length) {
        console.log("Daily queue completed.");
        return;
    }
    const track = dailyQueue[index];
    console.log(`Now playing: ${track.name} (ID: ${track.id})`);
    const cleanTrackName = track.name.replace(/\.mp3$/, "").trimEnd();
    const newChannelName = `Tempo.Radio | Now playing: ${cleanTrackName}`.slice(0, 100);
    const channel = connection?.joinConfig.channelId
        ? client.channels.cache.get(connection.joinConfig.channelId)
        : null;
    if (channel) {
        try {
            await channel.setName(newChannelName);
            console.log(`Channel name updated: ${newChannelName}`);
        }
        catch (error) {
            console.error("Error updating channel name:", error.message);
        }
    }
    try {
        const response = await drive.files.get({ fileId: track.id, alt: "media" }, { responseType: "stream" });
        const inputStream = response.data;
        // Увеличиваем буфер до 512 КБ
        const bufferStream = new stream_1.PassThrough({ highWaterMark: 1024 * 1024 });
        inputStream.pipe(bufferStream);
        const resource = (0, voice_1.createAudioResource)(bufferStream, {
            inlineVolume: true,
            inputType: voice_1.StreamType.Arbitrary,
        });
        if (resource.volume)
            resource.volume.setVolume(1.0);
        if (!connection || connection.state.status === "disconnected") {
            const channel = client.channels.cache.get("1344225046549368879");
            if (!channel)
                throw new Error("Канал не найден");
            connection = (0, voice_1.joinVoiceChannel)({
                channelId: channel.id,
                guildId: channel.guild.id,
                adapterCreator: channel.guild.voiceAdapterCreator,
                selfMute: false,
                selfDeaf: false,
            });
        }
        const subscription = connection.subscribe(player);
        if (!subscription)
            throw new Error("Ошибка подписки");
        player.play(resource);
        console.log("Воспроизведение начато");
    }
    catch (error) {
        console.error("Ошибка воспроизведения:", error.message);
        index++;
        return playNext();
    }
    player.once(voice_1.AudioPlayerStatus.Idle, () => {
        console.log("Трек завершён");
        if (global.gc)
            global.gc();
        index++;
        playNext();
    });
}
async function playMusic(channel) {
    connection = (0, voice_1.joinVoiceChannel)({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfMute: false,
        selfDeaf: false,
    });
    await new Promise((resolve) => {
        connection.on("stateChange", (oldState, newState) => {
            console.log(`Состояние соединения: ${newState.status}`);
            if (newState.status === "ready")
                resolve();
        });
    });
    dailyQueue = await getRandomTracks(20);
    index = 0;
    await playNext();
    node_cron_1.default.schedule("0 4 * * *", async () => {
        console.log("Обновление очереди в 4 утра...");
        dailyQueue = await getRandomTracks(20);
        index = 0;
        await playNext();
    });
}
client.once("ready", () => {
    console.log("Bot is ready!");
    const channel = client.channels.cache.get("1344225046549368879");
    if (!channel)
        console.log("Канал не найден!");
    else
        playMusic(channel);
});
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
client.login(DISCORD_TOKEN).catch((error) => {
    console.error("Ошибка входа:", error);
});
