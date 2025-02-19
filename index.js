const fs = require("fs");

const {
    connectGateway,
    formatString,
    clearCache,
    random,
    log,
    debug
} = require("./utils");

// config stuff
const secrets = require("./secrets.json");
const config = require("./config.json");
const promptData = require("./data.json");

// prompts
let systemPromptText = fs.readFileSync(config.systemPromptLocation, "utf-8");
let userPromptText = fs.readFileSync(config.userPromptLocation, "utf-8");
let conversationPromptText = fs.readFileSync(config.conversationPromptLocation, "utf-8");

// monitor prompts for changes
fs.watchFile(config.systemPromptLocation, () => systemPromptText = fs.readFileSync(config.systemPromptLocation, "utf-8"));
fs.watchFile(config.userPromptLocation, () => userPromptText = fs.readFileSync(config.userPromptLocation, "utf-8"));
fs.watchFile(config.conversationPromptLocation, () => conversationPromptText = fs.readFileSync(config.conversationPromptLocation, "utf-8"));

// functions
const responseParser = require("./responseParser");

// consts
const cache = {
    channels: [],
};
const allHistory = [];
const rateLimits = [];
const startDate = new Date();

// intervals
setInterval(() => checkHistory(allHistory), config.historyCheck); // update history loop
if (config.cache && config.cacheResetInterval) setInterval(clearCache, config.cacheResetInterval); // cache reset loop
if (config.startConversations) setInterval(startConversations, config.startConversationsInterval); // start conversation loop
// if (config.startConversations) startConversations();

// main
debug("Debug mode is enabled!");
log(`${promptData.name ? `${promptData.name} is` : "I'm"} waking up... be scared`);
main();

function main() {
    const discordClient = {
        user: {},
        lastSequenceNumber: null,
        connectDate: null
    };

    const gateway = connectGateway();
    log(`Conecting to Discord gateway at '${gateway.gatewayUrl}'`);

    gateway.on("open", () => {
        debug("Connected to Discord gateway");
        discordClient.connectDate = new Date();
    });

    // hello
    gateway.once("op-10", ({ d: data }) => {
        // heartbeat
        const { heartbeat_interval: heartbeatInterval } = data;
        log(`Setting heartbeat interval to ${heartbeatInterval}`);
        gateway.whileConnected(sendHeartbeat, heartbeatInterval);

        // identify
        sendPayload(2, {
            token: secrets.discordToken,
            intents: config.discord.intents,
            properties: config.discord.properties,
            presence: config.discord.presence
        });
    });

    // events (dispatch)
    gateway.on("event", async ({ s: sequenceNumber, t: event, d: data }) => {
        if (sequenceNumber !== null) discordClient.lastSequenceNumber = sequenceNumber;
        if (event === "READY") {
            discordClient.user = data.user;
            // discordClient.more shit, FUCK OFF!

            log(`Online as ${discordClient.user.global_name ? `${discordClient.user.global_name}, ` : ""}${discordClient.user.username}${parseInt(discordClient.user.discriminator) ? `#${discordClient.user.discriminator}` : ""} (${discordClient.user.id})`);
            log(`${discordClient.user.global_name || discordClient.user.username} is awake, lock your doors`);
        } else
            if (event === "MESSAGE_CREATE") {
                const channelId = data.channel_id;
                const channel = await getChannel(channelId).catch(err => log(`Failed to get channel '${channelId}'`));
                if (!channel) return; // if failed to get channel
                const guildId = data.guild_id;
                const isMentioned = data.mentions?.some(i => i.id === discordClient.user.id);
                const isServer = channel.type === 0;
                const isDm = channel.type === 1;
                const isGroupChat = channel.type === 3;
                const type = isServer ? "Server" : isDm ? "DM" : isGroupChat ? "Group Chat" : null;
                const message = data.content
                    .replace(new RegExp(`<@${discordClient.user.id}>`, "g"), discordClient.user.global_name || discordClient.user.username); // replace mention with username

                if (data.author.id === discordClient.user.id) return; // message from self
                if (data.author.bot && !config.respondToBots) return; // bot
                if (!message) return; // no message (eg. attachment with no message content)
                if (!type) return; // unknown channel type (thread, etc)
                if (config.ignorePrefix && config.ignorePrefix?.some(i => message.startsWith(i))) return; // message starts with ignore prefix
                if (rateLimits.includes(channelId)) return; // channel is rate limited
                if (config.blacklistedChannels?.includes(channelId)) return; // blacklisted channel
                if (isServer && config.blacklistedServers?.includes(guildId)) return; // blacklisted server
                if (!config.respondToAllMentions || (config.respondToAllMentions && !isMentioned)) {
                    if (isServer && !config.respondToAllServers && !config.serverChannels.includes(channelId) && !config.servers.includes(guildId)) return; // is server
                    if (isDm && !config.respondToAllDms && !config.dmChannels.includes(channelId)) return; // is dm
                    if (isGroupChat && !config.respondToAllGroupChats && !config.groupChatChannels.includes(channelId)) return; // is gc
                }

                // commands
                // if (config.commands && isMentioned && config.owners?.includes(data.author.id)) {
                if (config.commands && isMentioned) {
                    const messageWords = message.split(" ");
                    const commandIndex = messageWords.findIndex(i => i.toLowerCase().startsWith(config.commandsPrefix?.toLowerCase()));
                    if (commandIndex >= 0) {
                        if (!config.owners?.includes(data.author.id)) return await sendMessage(channelId, "your not my daddy!").catch(err => { });
                        const command = messageWords[commandIndex].substring(config.commandsPrefix?.length).toLowerCase();
                        const args = messageWords.slice(commandIndex + 1);
                        if (command === "shutdown" || command === "restart" || command === "reboot") {
                            log(`Told to shutdown`);
                            await sendMessage(channelId, "ok :(").catch(err => { });
                            return process.exit(0);
                        } else
                        if (command === "say") {
                            return await sendMessage(channelId, args.join(" ")).catch(err => { });;
                        }
                        if (command === "uptime") {
                            return await sendMessage(channelId, `started on \`${startDate.toUTCString()}\` (${Math.floor((Date.now() - startDate) / 1000)} seconds, work it out urself), last connected to discord gateway on \`${discordClient.connectDate.toUTCString()}\``).catch(err => { });
                        } else
                        if (command === "system-prompt") {
                            return await sendMessage(channelId, `\`\`\`\n${systemPromptText}\n\`\`\``).catch(err => { });
                        } else
                        if (command === "user-prompt") {
                            return await sendMessage(channelId, `\`\`\`\n${userPromptText}\n\`\`\``).catch(err => { });
                        } else
                        if (command === "conversation-prompt") {
                            return await sendMessage(channelId, `\`\`\`\n${conversationPromptText}\n\`\`\``).catch(err => { });
                        }
                    }
                }

                // ai
                const promptObject = {
                    // stuff to pass to the prompt, like usernames etc
                    message,
                    guildId,
                    referencedMessage: data.referenced_message,
                    me: discordClient,
                    author: data.author,
                    member: data.member,
                    channel,
                    channelId,
                    type,
                    isServer,
                    isDm,
                    isGroupChat,
                    timestamp: new Date().toUTCString(),
                    ...promptData
                };

                const historyIndex = allHistory.findIndex(i => i.channelId === channelId);
                const history = historyIndex >= 0 ? allHistory[historyIndex] : allHistory[allHistory.push({
                    channelId,
                    channel,
                    systemPrompt: formatString(systemPromptText, promptObject),
                    messages: [],
                    created: Date.now(),
                    lastUpdated: Date.now(),
                    startedConversation: false,
                    multipleMessages: false,
                    currentlyResponding: false,
                    typing: false
                }) - 1];

                if (history.currentlyResponding) {
                    history.multipleMessages = true;
                    if (config.cancelMultipleMessages) return;
                }

                history.startedConversation = false;
                history.currentlyResponding = true;

                const userPrompt = formatString(userPromptText, promptObject);

                // console.log("System prompt:", history.systemPrompt);
                // console.log("User prompt:", userPrompt);
                // console.log("History:", history.messages);

                // add rate limit
                if (config.rateLimit) {
                    rateLimits.push(channelId);
                    setTimeout(() => {
                        const index = rateLimits.findIndex(i => i === channelId);
                        if (index >= 0) rateLimits.splice(index, 1);
                    }, config.rateLimit);
                }

                const beforeResponseDate = Date.now();

                // startTyping(channelId).catch(err => log(`Failed to trigger typing indicator for channel '${channelId}':`, err)); // start typing
                // get generated response
                await generateResponse(userPrompt, history).then(async response => {
                    const parsedResponse = responseParser(response.content);
                    const responseMessage = parsedResponse.message;

                    if (config.ignoreHistory) addHistory(response, history); // add response to history even if it is an ignored response

                    if (parsedResponse.ignored || !parsedResponse.message) {
                        log(`[${channelId}]`, "[Ignored]", `"${message.replace(/\n/g, " ")}"${parsedResponse.ignoredReason ? `. Reason: ${parsedResponse.ignoredReason}` : ""}`);
                        if (config.debug) sendMessage(channelId, `[DEBUG] Ignored${parsedResponse.ignoredReason ? ` for '${parsedResponse.ignoredReason}'` : ""}`).catch(err => { });
                        history.multipleMessages = false;
                        history.currentlyResponding = false;
                        history.typing = false;
                        return;
                    }

                    if (!config.ignoreHistory) addHistory(response, history); // add response to history only if it isnt an ignored response

                    const speech = config.generateSpeech ? await generateSpeech(responseMessage).catch(err => log(`Failed to generate speech for '${responseMessage}':`, err)) : null;

                    // create delay, readDelayPerCharacter will be multiplied by message length, thinkDelayMin and thinkDelayMax is a random delay between and respondDelayPerCharacter will be multiplied by response length
                    const readDelay = (config.readDelayPerCharacter * message.length);
                    const thinkDelay = random(config.thinkDelayMin, config.thinkDelayMax);
                    const respondDelay = (config.respondDelayPerCharacter * responseMessage.length);
                    const delay = readDelay + thinkDelay + respondDelay;

                    const trueDelay = Math.max(Math.min(delay - (Date.now() - beforeResponseDate), config.delayMax), 0);

                    debug(`Delaying response by ${trueDelay}ms (read: ${readDelay}ms, think: ${thinkDelay}ms, respond: ${respondDelay})`);

                    if (trueDelay - respondDelay > 100 && config.typing) setTimeout(() => {
                        startTypingLoop(channelId, history).catch(err => { });
                    }, trueDelay - respondDelay);

                    setTimeout(() => {
                        const messageOptions = {
                            message_reference: (config.reply || (config.replyIfMultipleMessages && history.multipleMessages)) ? { type: 0, message_id: data.id, channel_id: channelId, guild_id: guildId, fail_if_not_exists: false } : undefined,
                            allowed_mentions: { replied_user: config.replyMention }
                        };

                        history.multipleMessages = false;
                        history.currentlyResponding = false;
                        history.typing = false;

                        // send generated response to discord
                        const attachments = [];
                        if (speech) attachments.push({ name: `${config.speechFileName}.mp3`, type: "audio/mp3", data: speech });
                        sendMessage(channelId, speech && config.speechOnly ? "" : responseMessage, messageOptions, attachments).then(() => {
                            log(`[${channelId}]`, "[Message]", `"${message.replace(/\n/g, " ")}" > "${responseMessage.replace(/\n/g, " ")}"`);
                        }).catch(err => {
                            log(`[${channelId}]`, "[Error]", "Failed to send generated response:", err);
                            sendMessage(channelId, "Couldn't send generated response, but managed to send this?", messageOptions).catch(err => { });
                        });
                    }, trueDelay);
                }).catch(err => {
                    history.multipleMessages = false;
                    history.currentlyResponding = false;
                    history.typing = false;
                    log(`[${channelId}]`, "[Error]", "Failed to generate response", err);
                    sendMessage(channelId, `Failed to generate response\n\`\`\`\n${err}\n\`\`\``);
                });
            } else {
                // log(`Received unhandled event '${event}'`); // doesnt matter
            }
    });

    gateway.on("close", () => {
        log(`Discord gateway closed, reconnecting in ${config.reconnectTimeout / 1000} second(s)...`);
        setTimeout(main, config.reconnectTimeout);
    });

    function sendPayload(op, data) {
        gateway.sendJson({ op, d: data });
    }

    function sendHeartbeat() {
        sendPayload(1, discordClient.lastSequenceNumber ?? null);
    }
}

async function startConversations() {
    if (!config.startConversations) return;

    for (const channelId of config.startConversationsChannels) {
        const randomNum = random(1, 100);
        if (randomNum > config.startConversationsChance) {
            debug(`Not starting conversation for channel '${channelId}', ${randomNum} over ${config.startConversationsChance}`);
            continue;
        };
        debug(`Trying to start conversation for channel '${channelId}'`);

        const channel = await getChannel(channelId).catch(err => {
            log(`Failed to get channel '${channelId}' while starting conversation`);
        });
        if (!channel) continue;

        const isServer = channel.type === 0;
        const isDm = channel.type === 1;
        const isGroupChat = channel.type === 3;
        const type = isServer ? "Server" : isDm ? "DM" : isGroupChat ? "Group Chat" : null;

        const promptObject = {
            channel,
            channelId,
            type,
            isServer,
            isDm,
            isGroupChat,
            timestamp: new Date().toUTCString(),
            ...promptData
        };

        const historyIndex = allHistory.findIndex(i => i.channelId === channelId);
        const history = historyIndex >= 0 ? allHistory[historyIndex] : allHistory[allHistory.push({
            channelId,
            channel,
            systemPrompt: formatString(systemPromptText, promptObject),
            messages: [],
            created: Date.now(),
            lastUpdated: Date.now(),
            startedConversation: false,
            multipleMessages: false,
            currentlyResponding: false,
            typing: false
        }) - 1];

        if (history.startedConversation) {
            // already started conversation previously
            debug(`Already tried starting conversation in channel '${channelId}' with no response, not trying again`);
            continue;
        };
        if (historyIndex >= 0 && Date.now() - history.lastUpdated < config.startConversationsMinTime) {
            // conversation possibly already going on
            debug(`Conversation possibly already going on in channel '${channelId}', not trying again`);
            continue;
        }

        history.startedConversation = true;
        history.currentlyResponding = true;

        const conversationPrompt = formatString(conversationPromptText, promptObject);

        await generateResponse(conversationPrompt, history).then(async response => {
            const parsedResponse = responseParser(response.content);
            const responseMessage = parsedResponse.message;

            if (parsedResponse.ignored || !parsedResponse.message) {
                debug("Ignored while trying to start conversation");
                history.multipleMessages = false;
                history.currentlyResponding = false;
                history.typing = false;
                return;
            }

            addHistory(response, history);

            const speech = config.generateSpeech ? await generateSpeech(responseMessage).catch(err => log(`Failed to generate speech for '${responseMessage}':`, err)) : null;

            const respondDelay = (config.respondDelayPerCharacter * responseMessage.length);

            if (respondDelay > 100 && config.typing) startTypingLoop(channelId, history).catch(err => { });

            setTimeout(() => {
                history.multipleMessages = false;
                history.currentlyResponding = false;
                history.typing = false;

                // send generated response to discord
                const attachments = [];
                if (speech) attachments.push({ name: `${config.speechFileName}.mp3`, type: "audio/mp3", data: speech });
                sendMessage(channelId, speech && config.speechOnly ? "" : config.debug ? `[DEBUG] Starting Conversation: ${responseMessage}` : responseMessage, { }, attachments).then(() => {
                    log(`[${channelId}]`, "[Starting Conversation]", `"${responseMessage.replace(/\n/g, " ")}"`);
                }).catch(err => {
                    log(`[${channelId}]`, "[Error]", "Failed to send generated response while starting conversation:", err);
                });
            }, respondDelay);
        }).catch(err => {
            history.multipleMessages = false;
            history.currentlyResponding = false;
            history.typing = false;
            log(`[${channelId}]`, "[Error]", "Failed to generate response while starting conversation", err);
        });
    }
}

function startTypingLoop(channelId, history) {
    return new Promise((resolve, reject) => {
        history.typing = true;
        startTyping(channelId).then(i => {
            setTimeout(() => {
                if (history.typing) return startTypingLoop(channelId, history);
            }, 9 * 1000);
            resolve();
        }).catch(err => {
            debug(err);
            reject(err);
        });
    });
}

function startTyping(channelId) {
    return new Promise((resolve, reject) => {
        debug(`Triggering typing indicator in channel '${channelId}'`);
        fetch(`${config.discord.apiBaseUrl}/v${config.discord.apiVersion}/channels/${channelId}/typing`, {
            method: "POST",
            headers: {
                Authorization: `${!config.discord.isUser ? "Bot " : ""}${secrets.discordToken}`
            }
        }).then(async response => {
            const json = await response.json().catch(err => { });
            if (response.status === 204) {
                resolve();
            } else {
                const error = `Got status code ${response.status}, message: ${json?.message}, code: ${json?.code}`;
                debug(error);
                reject(error);
            }
        }).catch(err => {
            debug(err);
            reject(err);
        });
    });
}

function getChannel(channelId) {
    return new Promise((resolve, reject) => {
        const cachedChannel = cache.channels.find(i => i.id === channelId);
        debug(`Getting channel '${channelId}'${cachedChannel ? ` [CACHED]` : ""}`);
        if (cachedChannel) return resolve(cachedChannel);
        fetch(`${config.discord.apiBaseUrl}/v${config.discord.apiVersion}/channels/${channelId}`, {
            method: "GET",
            headers: {
                Authorization: `${!config.discord.isUser ? "Bot " : ""}${secrets.discordToken}`
            }
        }).then(async response => {
            const json = await response.json().catch(err => { });
            if (response.status === 200 && json?.id) {
                cache.channels.push(json);
                resolve(json);
            } else {
                const error = `Got status code ${response.status}, message: ${json?.message}, code: ${json?.code}`;
                debug(error);
                reject(error);
            }
        }).catch(err => {
            debug(err);
            reject(err);
        });
    });
}

// function sendMessage(channelId, message, options) {
//     return new Promise((resolve, reject) => {
//         debug(`Sending message in channel '${channelId}'`);
//         fetch(`${config.discord.apiBaseUrl}/v${config.discord.apiVersion}/channels/${channelId}/messages`, {
//             method: "POST",
//             headers: {
//                 "Content-Type": "application/json",
//                 Authorization: `${!config.discord.isUser ? "Bot " : ""}${secrets.discordToken}`
//             },
//             body: JSON.stringify({
//                 content: message,
//                 ...options
//             })
//         }).then(async response => {
//             const json = await response.json().catch(err => { });
//             if (response.status === 200 && json?.id) {
//                 resolve();
//             } else {
//                 const error = `Got status code ${response.status}, message: ${json?.message}, code: ${json?.code}`;
//                 debug(error);
//                 reject(error);
//             }
//         }).catch(err => {
//             debug(err);
//             reject(err);
//         });
//     });
// }

function sendMessage(channelId, message, options, attachments = [ ]) {
    return new Promise((resolve, reject) => {
        debug(`Sending message in channel '${channelId}'`);
        const formData = new FormData();
        formData.append("payload_json", JSON.stringify({
            content: message.length > 2000 ? `${message.substring(0, 2000 - 3)}...` : message,
            ...(options || {})
        }));
        if (message.length > 2000) attachments?.push({ name: `${config.longMessageFileName}.txt`, type: "text/plain", data: message });
        for (const attachmentIndex in attachments) {
            const attachment = attachments[attachmentIndex];
            formData.append(`files[${attachmentIndex}]`, new Blob([attachment.data], { type: attachment.type }), attachment.name);
        }
        fetch(`${config.discord.apiBaseUrl}/v${config.discord.apiVersion}/channels/${channelId}/messages`, {
            method: "POST",
            headers: {
                Authorization: `${!config.discord.isUser ? "Bot " : ""}${secrets.discordToken}`
            },
            body: formData
        }).then(async response => {
            const json = await response.json().catch(err => { });
            if (response.status === 200 && json?.id) {
                resolve();
            } else {
                const error = `Got status code ${response.status}, message: ${json?.message}, code: ${json?.code}`;
                debug(error);
                reject(error);
            }
        }).catch(err => {
            debug(err);
            reject(err);
        });
    });
}

function generateResponse(prompt, history) {
    return new Promise((resolve, reject) => {
        // debug(`Generating response for '${prompt}'`);
        debug("Generating response");

        if (prompt) addHistory({ role: "user", content: prompt }, history);

        const messages = [...history.messages];
        if (history.systemPrompt) messages.unshift({
            role: "system",
            content: history.systemPrompt
        });

        fetch(`${config.openAi.apiBaseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${secrets.openAiApiKey}`
            },
            body: JSON.stringify({
                model: config.openAi.model,
                messages,
                temperature: config.openAi.temperature
            })
        }).then(async response => {
            const json = await response.json().catch(err => { });
            if (response.status === 200 && json?.id) {
                debug(`Generated response used ${json.usage.prompt_tokens} tokens for prompt and ${json.usage.completion_tokens} tokens for completion (${json.usage.total_tokens} total)`);
                const message = json.choices[0].message;
                history.lastUpdated = Date.now();
                resolve(message);
            } else {
                const error = `Got status code ${response.status}, error: ${json?.error}`;
                debug(error);
                reject(error);
            }
        }).catch(err => {
            debug(err);
            reject(err);
        });
    });
}

function generateSpeech(text) {
    return new Promise((resolve, reject) => {
        debug("Generating speech");

        fetch(`${config.elevenLabs.apiBaseUrl}/v1/text-to-speech/${config.elevenLabs.voiceId}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "xi-api-key": secrets.elevenLabsApiKey
            },
            body: JSON.stringify({
                text,
                model_id: config.elevenLabs.model,
                language_code: config.elevenLabs.languageCode,
                voice_settings: {
                    stability: config.elevenLabs.stability / 100,
                    similarity_boost: config.elevenLabs.similarity / 100,
                    use_speaker_boost: config.elevenLabs.speakerBoost
                }
            })
        }).then(async response => {
            if (response.status === 200) {
                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                resolve(buffer);
            } else {
                const json = await response.json().catch(err => { });
                const error = `Got status code ${response.status}, error: ${json?.detail?.message}`;
                debug(error);
                reject(error);
            }
        }).catch(err => {
            debug(err);
            reject(err);
        });
    });
}

function addHistory(message, history) {
    history.messages.push(message);
    history.lastUpdated = Date.now();
}

function checkHistory(allHistory) {
    for (let historyIndex = allHistory.length - 1; historyIndex >= 0; historyIndex--) {
        const history = allHistory[historyIndex];
        // log(history);
        const lastUpdated = Date.now() - history.lastUpdated;
        const messagesLength = history.messages.length;
        if (lastUpdated >= config.historyDelete && !history.startedConversation) {
            // remove all history if unused for a while
            log(`[${history.channelId}]`, "[Info]", "Removing history");
            allHistory.splice(historyIndex, 1);
        } else if (messagesLength > config.historyLength) {
            // keeps history within length
            log(`[${history.channelId}]`, "[Info]", `Truncating history (${messagesLength} > ${config.historyLength})`);
            history.messages.splice(0, messagesLength - config.historyLength);
        }
    }
}