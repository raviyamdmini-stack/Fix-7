const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const { Octokit } = require('@octokit/rest');
const mongoose = require('mongoose');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const os = require('os');
const { sms, downloadMediaMessage } = require("./msg");
var {
  connectdb,
  input,
  get,
  getalls,
  resetSettings,
} = require("./configdb")
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    S_WHATSAPP_NET
} = require('baileys');

const config = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'false',
    AUTO_LIKE_EMOJI: ['💋', '🍬', '💗', '🎈', '🎉', '🥳', '❤️', '🧫', '🐭'],
    PREFIX: '.',
    MAX_RETRIES: 3,
    GROUP_INVITE_LINK: 'https://chat.whatsapp.com/LFxZrJIPHSTK2JAYunxrvu',
    ADMIN_LIST_PATH: './admin.json',
    RCD_IMAGE_PATH: './DTZ.jpg',
    NEWSLETTER_JID: '120363396379901844@newsletter',
    NEWSLETTER_MESSAGE_ID: '428',
    OTP_EXPIRY: 9999999,
    OWNER_NUMBER: '94702884908',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029Vb4NzEGDOQIP2mJXmo3T'
};

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const NUMBER_LIST_PATH = './numbers.json';
const otpStore = new Map();

// MongoDB Schema
const SessionSchema = new mongoose.Schema({
    number: { type: String, unique: true, required: true },
    creds: { type: Object, required: true },
    config: { type: Object },
    updatedAt: { type: Date, default: Date.now }
});
const Session = mongoose.model('Session', SessionSchema);

// MongoDB Connection
async function connectMongoDB() {
    try {
        const mongoUri = process.env.MONGO_URI || 'mongodb+srv://knight_rider:GODGURU12345@knight.jm59gu9.mongodb.net/ASHUMD?retryWrites=true&w=majority';
        await mongoose.connect(mongoUri, {
            useNewUrlParser: true,
            useUnifiedTopology: true
        });
        console.log('Connected to MongoDB');
    } catch (error) {
        console.error('MongoDB connection failed:', error);
        process.exit(1);
    }
}
connectMongoDB();

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

function initialize() {
    activeSockets.clear();
    socketCreationTime.clear();
    console.log('Cleared active sockets and creation times on startup');
}

async function autoReconnectOnStartup() {
    try {
        let numbers = [];
        if (fs.existsSync(NUMBER_LIST_PATH)) {
            numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
            console.log(`Loaded ${(numbers.length)} numbers from numbers.json`);
        } else {
            console.warn('No numbers.json found, checking MongoDB for sessions...');
        }

        const sessions = await Session.find({}, 'number').lean();
        const mongoNumbers = sessions.map(s => s.number);
        console.log(`Found ${mongoNumbers.length} numbers in MongoDB sessions`);

        numbers = [...new Set([...numbers, ...mongoNumbers])];
        if (numbers.length === 0) {
            console.log('No numbers found in numbers.json or MongoDB, skipping auto-reconnect');
            return;
        }

        console.log(`Attempting to reconnect ${numbers.length} sessions...`);
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                console.log(`Number ${number} already connected, skipping`);
                continue;
            }
            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            try {
                await EmpirePair(number, mockRes);
                console.log(`Initiated reconnect for ${number}`);
            } catch (error) {
                console.error(`Failed to reconnect ${number}:`, error);
            }
            await delay(1000);
        }
    } catch (error) {
        console.error('Auto-reconnect on startup failed:', error);
    }
}

initialize();
setTimeout(autoReconnectOnStartup, 5000);

function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

async function joinGroup(socket) {
    let retries = config.MAX_RETRIES;
    const inviteCodeMatch = config.GROUP_INVITE_LINK.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
    if (!inviteCodeMatch) {
        console.error('Invalid group invite link format');
        return { status: 'failed', error: 'Invalid group invite link' };
    }
    const inviteCode = inviteCodeMatch[1];

    while (retries > 0) {
        try {
            const response = await socket.groupAcceptInvite(inviteCode);
            if (response?.gid) {
                console.log(`Successfully joined group with ID: ${response.gid}`);
                return { status: 'success', gid: response.gid };
            }
            throw new Error('No group ID in response');
        } catch (error) {
            retries--;
            let errorMessage = error.message || 'Unknown error';
            if (error.message.includes('not-authorized')) {
                errorMessage = 'Bot is not authorized to join (possibly banned)';
            } else if (error.message.includes('conflict')) {
                errorMessage = 'Bot is already a member of the group';
            } else if (error.message.includes('gone')) {
                errorMessage = 'Group invite link is invalid or expired';
            }
            console.warn(`Failed to join group, retries left: ${retries}`, errorMessage);
            if (retries === 0) {
                return { status: 'failed', error: errorMessage };
            }
            await delay(2000 * (config.MAX_RETRIES - retries));
        }
    }
    return { status: 'failed', error: 'Max retries reached' };
}

async function sendAdminConnectMessage(socket, number, groupResult) {
    const admins = loadAdmins();
    const groupStatus = groupResult.status === 'success'
        ? `Joined (ID: ${groupResult.gid})`
        : `Failed to join group: ${groupResult.error}`;
    const caption = formatMessage(
        '`ᴅᴛᴢ ᴍɪɴɪ ʙᴏᴛ ᴄᴏɴɴᴇᴄᴛᴇᴅ ꜱᴜᴄᴄᴇꜱꜱꜰᴜʟʟʏ 💬`',
        `*©: ᴅᴛᴢ ᴍɪɴɪ ʙᴏᴛ ɪɴꜰᴏ 📌*\n*• \`ᴠᴇʀꜱɪᴏɴ\` : ᴠ1.0.0*\n*• \`ʙᴏᴛ ᴄᴏɴɴᴇᴄᴛ ɴʙ\` : ${number}*\n*• \`ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴛᴇᴀᴍ\` : ᴅᴀʀᴋ ᴛᴇᴄʜ ᴢᴏɴᴇ*\n\n*• ᴅᴛᴍ ᴍɪɴɪ ꜰʀᴇᴇ ʙᴏᴛ සාර්ථක ලෙස ᴄᴏɴɴᴇᴄᴛ වී ඇත 💫*\n\n*🌐 ᴅᴛᴢ ᴍɪɴɪ ʙᴏᴛ ᴍᴀɪɴ ᴡᴇʙ ꜱɪᴛᴇ :*\n> https://dtz-free-mini-bot-v1-c0f676db007b.herokuapp.com/`,
        '© ᴄʀᴇᴀᴛᴇᴅ ʙʏ ᴛʜᴇ ᴅᴀʀᴋ ᴛᴇᴄʜ ᴢᴏɴᴇ'
    );

    for (const admin of admins) {
        try {
            await socket.sendMessage(
                `${admin}@s.whatsapp.net`,
                {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption
                }
            );
        } catch (error) {
            console.error(`Failed to send connect message to admin ${admin}:`, error);
        }
    }
}

async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage(
        '🔐 OTP VERIFICATION',
        `Your OTP for config update is: *${otp}*\nThis OTP will expire in 5 minutes.`,
        '© ᴄʀᴇᴀᴛᴇᴅ ʙʏ ᴛʜᴇ ᴅᴀʀᴋ ᴛᴇᴄʜ ᴢᴏɴᴇ 📌'
    );

    try {
        await socket.sendMessage(userJid, { text: message });
        console.log(`OTP ${otp} sent to ${number}`);
    } catch (error) {
        console.error(`Failed to send OTP to ${number}:`, error);
        throw error;
    }
}

async function updateAboutStatus(socket) {
    try {
        // About status update logic here
        console.log('About status updated successfully');
    } catch (error) {
        console.error('Error updating about status:', error);
    }
}

async function updateStoryStatus(socket) {
    try {
        // Story status update logic here
        console.log('Story status updated successfully');
    } catch (error) {
        console.error('Error updating story status:', error);
    }
}

function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key) return;

        const allNewsletterJIDs = await loadNewsletterJIDsFromRaw();
        const jid = message.key.remoteJid;

        if (!allNewsletterJIDs.includes(jid)) return;

        try {
            const emojis = ['💗', '❤️', '💙', '💜', '💛'];
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            const messageId = message.newsletterServerId;

            if (!messageId) {
                console.warn('No newsletterServerId found in message:', message);
                return;
            }

            let retries = 3;
            while (retries-- > 0) {
                try {
                    await socket.newsletterReactMessage(jid, messageId.toString(), randomEmoji);
                    console.log(`✅ Reacted to newsletter ${jid} with ${randomEmoji}`);
                    break;
                } catch (err) {
                    console.warn(`❌ Reaction attempt failed (${3 - retries}/3):`, err.message);
                    await delay(1500);
                }
            }
        } catch (error) {
            console.error('⚠️ Newsletter reaction handler failed:', error.message);
        }
    });
}
async function loadConfig(number) {
    try {
        const settings = await getalls(number); 
        if (settings) {
            Object.assign(config, settings);
        } else {
            console.warn(`No settings found for number: ${number}`);
        }
    } catch (error) {
        console.error('Error loading config:', error);
}
}
async function setupStatusHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant || message.key.remoteJid === config.NEWSLETTER_JID) return;

        try {
           
             if (config.AUTO_VIEW_STATUS === 'true') {
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.readMessages([message.key]);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }

            if (config.AUTO_LIKE_STATUS === 'true') {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            message.key.remoteJid,
                            { react: { text: randomEmoji, key: message.key } },
                            { statusJidList: [message.key.participant] }
                        );
                        console.log(`Reacted to status with ${randomEmoji}`);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}


async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;

        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        const deletionTime = getSriLankaTimestamp();
        
        const message = formatMessage(
            '🗑️ MESSAGE DELETED',
            `A message was deleted from your chat.\n📋 From: ${messageKey.remoteJid}\n🍁 Deletion Time: ${deletionTime}`,
            '© ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴅᴀʀᴋ ᴛᴇᴄʜ ᴢᴏɴᴇ 📌'
        );

        try {
            await socket.sendMessage(userJid, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: message
            });
            console.log(`Notified ${number} about message deletion: ${messageKey.id}`);
        } catch (error) {
            console.error('Failed to send deletion notification:', error);
        }
    });
}

async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}
async function oneViewmeg(socket, isOwner, msg ,sender) {
    if (isOwner) {  
    try {
    const akuru = sender
    const quot = msg
    if (quot) {
        if (quot.imageMessage?.viewOnce) {
            console.log("hi");
            let cap = quot.imageMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.imageMessage);
            await socket.sendMessage(akuru, { image: { url: anu }, caption: cap });
        } else if (quot.videoMessage?.viewOnce) {
            console.log("hi");
            let cap = quot.videoMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.videoMessage);
             await socket.sendMessage(akuru, { video: { url: anu }, caption: cap });
        } else if (quot.audioMessage?.viewOnce) {
            console.log("hi");
            let cap = quot.audioMessage?.caption || "";
            let anu = await socke.downloadAndSaveMediaMessage(quot.audioMessage);
             await socket.sendMessage(akuru, { audio: { url: anu }, caption: cap });
        } else if (quot.viewOnceMessageV2?.message?.imageMessage){
        
            let cap = quot.viewOnceMessageV2?.message?.imageMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2.message.imageMessage);
             await socket.sendMessage(akuru, { image: { url: anu }, caption: cap });
            
        } else if (quot.viewOnceMessageV2?.message?.videoMessage){
        
            let cap = quot.viewOnceMessageV2?.message?.videoMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2.message.videoMessage);
            await socket.sendMessage(akuru, { video: { url: anu }, caption: cap });

        } else if (quot.viewOnceMessageV2Extension?.message?.audioMessage){
        
            let cap = quot.viewOnceMessageV2Extension?.message?.audioMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2Extension.message.audioMessage);
            await socket.sendMessage(akuru, { audio: { url: anu }, caption: cap });
        }
        }        
        } catch (error) {
      }
    }

}

const handleSettingUpdate = async (settingType, newValue, reply, number) => {
  const currentValue = await get(settingType, number);
  var alreadyMsg = "*This setting alredy updated !*";
  if (currentValue === newValue) {
    return await reply(alreadyMsg);
  }
  await input(settingType, newValue, number);
  await reply(`➟ *${settingType.replace(/_/g, " ").toUpperCase()} updated: ${newValue}*`);
};

const updateSetting = async (settingType, newValue, reply, number) => {
  const currentValue = await get(settingType, number);
  if (currentValue === newValue) {
   var alreadyMsg = "*This setting alredy updated !*";
    return await reply(alreadyMsg);
  }
  await input(settingType, newValue, number);
  await reply(`➟ *${settingType.replace(/_/g, " ").toUpperCase()} updated: ${newValue}*`);
};
function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;
loadConfig(number).catch(console.error);
const type = getContentType(msg.message);
    if (!msg.message) return	
  msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
	const m = sms(socket, msg);
	const quoted =
        type == "extendedTextMessage" &&
        msg.message.extendedTextMessage.contextInfo != null
          ? msg.message.extendedTextMessage.contextInfo.quotedMessage || []
          : []
        const body = (type === 'conversation') ? msg.message.conversation 
    : msg.message?.extendedTextMessage?.contextInfo?.hasOwnProperty('quotedMessage') 
        ? msg.message.extendedTextMessage.text 
    : (type == 'interactiveResponseMessage') 
        ? msg.message.interactiveResponseMessage?.nativeFlowResponseMessage 
            && JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson)?.id 
    : (type == 'templateButtonReplyMessage') 
        ? msg.message.templateButtonReplyMessage?.selectedId 
    : (type === 'extendedTextMessage') 
        ? msg.message.extendedTextMessage.text 
    : (type == 'imageMessage') && msg.message.imageMessage.caption 
        ? msg.message.imageMessage.caption 
    : (type == 'videoMessage') && msg.message.videoMessage.caption 
        ? msg.message.videoMessage.caption 
    : (type == 'buttonsResponseMessage') 
        ? msg.message.buttonsResponseMessage?.selectedButtonId 
    : (type == 'listResponseMessage') 
        ? msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
    : (type == 'messageContextInfo') 
        ? (msg.message.buttonsResponseMessage?.selectedButtonId 
            || msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
            || msg.text) 
    : (type === 'viewOnceMessage') 
        ? msg.message[type]?.message[getContentType(msg.message[type].message)] 
    : (type === "viewOnceMessageV2") 
        ? (msg.msg.message.imageMessage?.caption || msg.msg.message.videoMessage?.caption || "") 
    : '';
	 	let sender = msg.key.remoteJid;
	  const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id) : (msg.key.participant || msg.key.remoteJid)
          const senderNumber = nowsender.split('@')[0]
          const developers = `${config.OWNER_NUMBER}`;
          const botNumber = socket.user.id.split(':')[0]
          const isbot = botNumber.includes(senderNumber)
          const isOwner = isbot ? isbot : developers.includes(senderNumber)
          var prefix = config.PREFIX
	  var isCmd = body.startsWith(prefix)
    	  const from = msg.key.remoteJid;
          const isGroup = from.endsWith("@g.us")
	      const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '.';
          var args = body.trim().split(/ +/).slice(1)
	  const reply = async(teks) => {
             return await socket.sendMessage(sender, { text: teks }, { quoted: msg })
          }
	 // settings tika
            const presence = config.PRESENCE;
            if (msg.key.remoteJid) {
                if (presence && presence !== "available") {
                    await socket.sendPresenceUpdate(presence, msg.key.remoteJid);
                } else {
                    await socket.sendPresenceUpdate("available", msg.key.remoteJid);
                }
            }
            if (config.AUTO_READ_MESSAGE === "cmd" && isCmd) {
                await socket.readMessages([msg.key]);
            } else if (config.AUTO_READ_MESSAGE === "all") {
                await socket.readMessages([msg.key]);
            }

            if (!isOwner && config.WORK_TYPE === "private") return;
            if (!isOwner && isGroup && config.WORK_TYPE === "inbox") return;
            if (!isOwner && !isGroup && config.WORK_TYPE === "groups") return;
socket.downloadAndSaveMediaMessage = async(message, filename, attachExtension = true) => {
                let quoted = message.msg ? message.msg : message
                let mime = (message.msg || message).mimetype || ''
                let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0]
                const stream = await downloadContentFromMessage(quoted, messageType)
                let buffer = Buffer.from([])
                for await (const chunk of stream) {
                    buffer = Buffer.concat([buffer, chunk])
                }
                let type = await FileType.fromBuffer(buffer)
                trueFileName = attachExtension ? (filename + '.' + type.ext) : filename
                await fs.writeFileSync(trueFileName, buffer)
                return trueFileName
}
        if (!command) return;
        
        let pinterestCache = {}; //

        try {
switch (command) {
//ube cmd add karapn

function setupMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        if (config.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
                console.log(`Set recording presence for ${msg.key.remoteJid}`);
            } catch (error) {
                console.error('Failed to set recording presence:', error);
            }
        }
    });
}
async function setupcallhandlers(socket, number) {
socket.ev.on('call', async (calls) => {
  try {
    await loadConfig(number).catch(console.error);
    if (config.ANTI_CALL === 'off') return;

    for (const call of calls) {
      if (call.status !== 'offer') continue; 

      const id = call.id;
      const from = call.from;

      await socket.rejectCall(id, from);
      await socket.sendMessage(from, {
        text: '*🔕 Your call was automatically rejected..!*'
      });
    }
  } catch (err) {
    console.error("Anti-call error:", err);
  }
});
}

async function saveSession(number, creds) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        await Session.findOneAndUpdate(
            { number: sanitizedNumber },
            { creds, updatedAt: new Date() },
            { upsert: true }
        );
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(creds, null, 2));
        let numbers = [];
        if (fs.existsSync(NUMBER_LIST_PATH)) {
            numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
        }
        if (!numbers.includes(sanitizedNumber)) {
            numbers.push(sanitizedNumber);
            fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
        }
        console.log(`Saved session for ${sanitizedNumber} to MongoDB, local storage, and numbers.json`);
    } catch (error) {
        console.error(`Failed to save session for ${sanitizedNumber}:`, error);
    }
}

async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const session = await Session.findOne({ number: sanitizedNumber });
        if (!session) {
            console.warn(`No session found for ${sanitizedNumber} in MongoDB`);
            return null;
        }
        if (!session.creds || !session.creds.me || !session.creds.me.id) {
            console.error(`Invalid session data for ${sanitizedNumber}`);
            await deleteSession(sanitizedNumber);
            return null;
        }
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(session.creds, null, 2));
        console.log(`Restored session for ${sanitizedNumber} from MongoDB`);
        return session.creds;
    } catch (error) {
        console.error(`Failed to restore session for ${number}:`, error);
        return null;
    }
}

async function deleteSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        await Session.deleteOne({ number: sanitizedNumber });
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
        if (fs.existsSync(sessionPath)) {
            fs.removeSync(sessionPath);
        }
        if (fs.existsSync(NUMBER_LIST_PATH)) {
            let numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
            numbers = numbers.filter(n => n !== sanitizedNumber);
            fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
        }
        console.log(`Deleted session for ${sanitizedNumber} from MongoDB, local storage, and numbers.json`);
    } catch (error) {
        console.error(`Failed to delete session for ${number}:`, error);
    }
}

async function loadUserConfig(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configDoc = await Session.findOne({ number: sanitizedNumber }, 'config');
        return configDoc?.config || { ...config };
    } catch (error) {
        console.warn(`No configuration found for ${number}, using default config`);
        return { ...config };
    }
}

async function updateUserConfig(number, newConfig) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        await Session.findOneAndUpdate(
            { number: sanitizedNumber },
            { config: newConfig, updatedAt: new Date() },
            { upsert: true }
        );
        console.log(`Updated config for ${sanitizedNumber}`);
    } catch (error) {
        console.error(`Failed to update config for ${number}:`, error);
        throw error;
    }
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_BASE = 3000; // ms

function setupAutoRestart(socket, number) {
    const id = number.replace(/[^0-9]/g, '');
    let reconnectAttempts = 0;
    let reconnecting = false;

    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        // Connection closed but not logged out
        if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== 401) {
            if (reconnecting) return; // Prevent double reconnect triggers
            reconnecting = true;

            if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                console.error(`[${id}] ❌ Max reconnect attempts reached. Cleaning session...`);
                cleanupSession(id);
                reconnecting = false;
                return;
            }

            reconnectAttempts++;
            const delayTime = RECONNECT_DELAY_BASE * reconnectAttempts;
            console.log(`[${id}] 🔄 Reconnecting in ${delayTime / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

            setTimeout(async () => {
                try {
                    cleanupSession(id);
                    const mockRes = createMockResponse();
                    await EmpirePair(number, mockRes);
                    console.log(`[${id}] ✅ Reconnected successfully`);
                    reconnectAttempts = 0;
                } catch (err) {
                    console.error(`[${id}] ❌ Reconnect failed:`, err);
                } finally {
                    reconnecting = false;
                }
            }, delayTime);
        }

        // Connection Opened
        else if (connection === 'open') {
            reconnectAttempts = 0;
            console.log(`[${id}] ✅ Connection opened`);
        }
    });
}

// Helper to cleanup session
function cleanupSession(id) {
    activeSockets.delete(id);
    socketCreationTime.delete(id);
}

// Fake response object for internal function call
function createMockResponse() {
    return {
        headersSent: false,
        send: () => {},
        status: () => createMockResponse()
    };
}

async function EmpirePair(number, res) {
    console.log(`Initiating pairing/reconnect for ${number}`);
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    await restoreSession(sanitizedNumber);

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        setupStatusHandlers(socket);
        setupCommandHandlers(socket, sanitizedNumber);
        setupMessageHandlers(socket);
        setupAutoRestart(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);
        handleMessageRevocation(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    console.log(`Generated pairing code for ${sanitizedNumber}: ${code}`);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code for ${sanitizedNumber}, retries left: ${retries}`, error.message);
                    if (retries === 0) throw error;
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
            if (!res.headersSent) {
                res.send({ code });
            }
        }

        socket.ev.on('creds.update', async () => {
            try {
                await saveCreds();
                const credsPath = path.join(sessionPath, 'creds.json');
                if (!fs.existsSync(credsPath)) {
                    console.error(`Creds file not found for ${sanitizedNumber}`);
                    return;
                }
                const fileContent = await fs.readFile(credsPath, 'utf8');
                const creds = JSON.parse(fileContent);
                await saveSession(sanitizedNumber, creds);
            } catch (error) {
                console.error(`Failed to save creds for ${sanitizedNumber}:`, error);
            }
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            console.log(`Connection update for ${sanitizedNumber}:`, update);
            if (connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);

                    await updateAboutStatus(socket);
                    await updateStoryStatus(socket);

                    const groupResult = await joinGroup(socket);

                    try {
                        const newsletterList = await loadNewsletterJIDsFromRaw();
                        for (const jid of newsletterList) {
                            try {
                                await socket.newsletterFollow(jid);
                                await socket.sendMessage(jid, { react: { text: '❤️', key: { id: '1' } } });
                                console.log(`✅ Followed and reacted to newsletter: ${jid}`);
                            } catch (err) {
                                console.warn(`⚠️ Failed to follow/react to ${jid}:`, err.message);
                            }
                        }
                        console.log('✅ Auto-followed newsletter & reacted');
                    } catch (error) {
                        console.error('❌ Newsletter error:', error.message);
                    }

                    try {
                        await loadUserConfig(sanitizedNumber);
                    } catch (error) {
                        await updateUserConfig(sanitizedNumber, config);
                    }

                    activeSockets.set(sanitizedNumber, socket);

                    const groupStatus = groupResult.status === 'success'
                        ? 'Joined successfully'
                        : `Failed to join group: ${groupResult.error}`;
                    await socket.sendMessage(userJid, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '`ᴅᴛᴢ ᴍɪɴɪ ʙᴏᴛ ᴄᴏɴɴᴇᴄᴛᴇᴅ ꜱᴜᴄᴄᴇꜱꜱꜰᴜʟʟʏ 💬`',
                            `*©: ᴅᴛᴢ ᴍɪɴɪ ʙᴏᴛ ɪɴꜰᴏ 📌*\n*• \`ᴠᴇʀꜱɪᴏɴ\` : ᴠ1.0.0*\n*• \`ʙᴏᴛ ᴄᴏɴɴᴇᴄᴛ ɴʙ\` : ${number}*\n*• \`ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴛᴇᴀᴍ\` : ᴅᴀʀᴋ ᴛᴇᴄʜ ᴢᴏɴᴇ*\n\n*• ᴅᴛᴍ ᴍɪɴɪ ꜰʀᴇᴇ ʙᴏᴛ සාර්ථක ලෙස ᴄᴏɴɴᴇᴄᴛ වී ඇත 💫*\n\n*🌐 ᴅᴛᴢ ᴍɪɴɪ ʙᴏᴛ ᴍᴀɪɴ ᴡᴇʙ ꜱɪᴛᴇ :*\n> https://dtz-free-mini-bot-v1-c0f676db007b.herokuapp.com/`,
                            '© ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴅᴀʀᴋ ᴛᴇᴄʜ ᴢᴏɴᴇ'
                        )
                    });

                    await sendAdminConnectMessage(socket, sanitizedNumber, groupResult);
                } catch (error) {
                    console.error('Connection error:', error);
                    exec(`pm2 restart ${process.env.PM2_NAME || 'DTZ-MINI-BOT-session'}`);
                }
            }
        });
    } catch (error) {
        console.error('Pairing/reconnect error:', error);
        socketCreationTime.delete(sanitizedNumber);
        if (!res.headersSent) {
            res.status(503).send({ error: 'Service Unavailable' });
        }
    }
}

router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    if (activeSockets.has(sanitizedNumber)) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected'
        });
    }

    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    console.log('Active sockets:', Array.from(activeSockets.keys()));
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        message: '🚓🚗 bot is running',
        activesession: activeSockets.size
    });
});

router.get('/connect-all', async (req, res) => {
    try {
        let numbers = [];
        if (fs.existsSync(NUMBER_LIST_PATH)) {
            numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH));
        }
        const sessions = await Session.find({}, 'number').lean();
        numbers = [...new Set([...numbers, ...sessions.map(s => s.number)])];

        if (numbers.length === 0) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

router.get('/reconnect', async (req, res) => {
    try {
        const sessions = await Session.find({}, 'number').lean();
        if (sessions.length === 0) {
            return res.status(404).send({ error: 'No sessions found in MongoDB' });
        }

        const results = [];
        for (const { number } of sessions) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            try {
                await EmpirePair(number, mockRes);
                results.push({ number, status: 'connection_initiated' });
            } catch (error) {
                console.error(`Failed to reconnect bot for ${number}:`, error);
                results.push({ number, status: 'failed', error: error.message });
            }
            await delay(1000);
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Reconnect error:', error);
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
});

router.get('/update-config', async (req, res) => {
    const { number, config: configString } = req.query;
    if (!number || !configString) {
        return res.status(400).send({ error: 'Number and config are required' });
    }

    let newConfig;
    try {
        newConfig = JSON.parse(configString);
    } catch (error) {
        return res.status(400).send({ error: 'Invalid config format' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const otp = generateOTP();
    otpStore.set(sanitizedNumber, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig });

    try {
        await sendOTP(socket, sanitizedNumber, otp);
        res.status(200).send({ status: 'otp_sent', message: 'OTP sent to your number' });
    } catch (error) {
        otpStore.delete(sanitizedNumber);
        res.status(500).send({ error: 'Failed to send OTP' });
    }
});

router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) {
        return res.status(400).send({ error: 'Number and OTP are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const storedData = otpStore.get(sanitizedNumber);
    if (!storedData) {
        return res.status(400).send({ error: 'No OTP request found for this number' });
    }

    if (Date.now() >= storedData.expiry) {
        otpStore.delete(sanitizedNumber);
        return res.status(400).send({ error: 'OTP has expired' });
    }

    if (storedData.otp !== otp) {
        return res.status(400).send({ error: 'Invalid OTP' });
    }

    try {
        await updateUserConfig(sanitizedNumber, storedData.newConfig);
        otpStore.delete(sanitizedNumber);
        const socket = activeSockets.get(sanitizedNumber);
        if (socket) {
            await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '✅ CONFIG UPDATED',
                    'Your configuration has been successfully updated!',
                    '㋛︎ ᴘᴏᴡᴇʀᴅ ʙʏ ᴍʀ ʟᴀᴋꜱɪᴅᴜ ᶜᵒᵈᵉʳ'
                )
            });
        }
        res.status(200).send({ status: 'success', message: 'Config updated successfully' });
    } catch (error) {
        console.error('Failed to update config:', error);
        res.status(500).send({ error: 'Failed to update config' });
    }
});

router.get('/getabout', async (req, res) => {
    const { number, target } = req.query;
    if (!number || !target) {
        return res.status(400).send({ error: 'Number and target number are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const targetJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    try {
        const statusData = await socket.fetchStatus(targetJid);
        const aboutStatus = statusData.status || 'No status available';
        const setAt = statusData.setAt ? moment(statusData.setAt).tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss') : 'Unknown';
        res.status(200).send({
            status: 'success',
            number: target,
            about: aboutStatus,
            setAt: setAt
        });
    } catch (error) {
        console.error(`Failed to fetch status for ${target}:`, error);
        res.status(500).send({
            status: 'error',
            message: `Failed to fetch About status for ${target}. The number may not exist or the status is not accessible.`
        });
    }
});

// Cleanup
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        socket.ws.close();
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    fs.emptyDirSync(SESSION_BASE_PATH);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    exec(`pm2 restart ${process.env.PM2_NAME || 'DTZ-MINI-BOT-session'}`);
});

module.exports = router;

async function loadNewsletterJIDsFromRaw() {
    try {
        const res = await axios.get('https://raw.githubusercontent.com/DTZ-GANG-BAILEYS/NUMBER-REPO/refs/heads/main/newsletter_list.json');
        return Array.isArray(res.data) ? res.data : [];
    } catch (err) {
        console.error('❌ Failed to load newsletter list from GitHub:', err.message);
        return [];
    }
}