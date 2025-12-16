
import express from 'express';
import cors from 'cors';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionsBitField } from 'discord.js';
import fs from 'fs';

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
// NOTA: No Railway, coloque estas variáveis nas "Variables" do projeto para segurança.
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
// --- DB SETUP ---
// No Railway, arquivos locais são efêmeros. Para persistência real, use Railway Volumes ou PostgreSQL.
// Este método JSON funciona, mas reseta se o bot reiniciar (Deploy).
const DB_FILE = 'users.json';
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({}));

// --- EXPRESS APP ---
const app = express();
app.use(cors());
app.use(express.json());

// Rota de Healthcheck (Railway precisa disso)
app.get('/', (req, res) => res.send('Roblox Executor Backend is Running.'));

// Sync Endpoint (O Site envia dados pra cá)
app.post('/sync-users', (req, res) => {
    const users = req.body;
    // Em produção, valide o token de admin aqui
    fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2));
    console.log('[SYNC] Database updated from Frontend.');
    res.json({ success: true });
});

// --- DISCORD BOT ---
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages],
    partials: [Partials.Channel]
});

client.once('ready', async () => {
    console.log(`[BOT] Logged in as ${client.user.tag}`);
    console.log('[BOT] System online on Railway.');
    
    // Setup Guilds
    client.guilds.cache.forEach(guild => setupGuild(guild));
});

// LOCKDOWN & SETUP LOGIC
async function setupGuild(guild) {
    try {
        const verifyChannelName = "verify";
        let channel = guild.channels.cache.find(c => c.name === verifyChannelName);

        if (!channel) {
            // Create Verify Channel
            channel = await guild.channels.create({
                name: verifyChannelName,
                permissionOverwrites: [
                    { id: guild.id, deny: [PermissionsBitField.Flags.SendMessages], allow: [PermissionsBitField.Flags.ViewChannel] }
                ]
            });
            
            // Hide other channels for everyone role (Security Lockdown)
            guild.channels.cache.forEach(c => {
                if (c.id !== channel.id) {
                    c.permissionOverwrites.edit(guild.id, { ViewChannel: false });
                }
            });

            // Send Embed
            const embed = new EmbedBuilder()
                .setTitle("🔐 VERIFICATION REQUIRED")
                .setDescription("Hi 👋 Please Verify Your Account to Get Access to the Site!")
                .setColor(0x5865F2)
                .setFooter({ text: "Roblox Executor Ultimate Security" });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('verify_btn')
                    .setLabel('VERIFY ACCOUNT')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('🛡️')
            );

            await channel.send({ embeds: [embed], components: [row] });
            console.log(`[BOT] Setup complete for ${guild.name}`);
        }
    } catch (error) {
        console.error(`[BOT] Error setting up guild ${guild.name}: `, error);
    }
}

// INTERACTION HANDLER
client.on('interactionCreate', async interaction => {
    // 1. BUTTON CLICK -> OPEN MODAL
    if (interaction.isButton() && interaction.customId === 'verify_btn') {
        const modal = new ModalBuilder()
            .setCustomId('verify_modal')
            .setTitle('Link Your Account');

        const userInput = new TextInputBuilder()
            .setCustomId('username_input')
            .setLabel("Site Username")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const pinInput = new TextInputBuilder()
            .setCustomId('pin_input')
            .setLabel("Security PIN")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(4)
            .setPlaceholder("1234")
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(userInput), new ActionRowBuilder().addComponents(pinInput));
        await interaction.showModal(modal);
    }

    // 2. MODAL SUBMIT -> VALIDATE USER
    if (interaction.isModalSubmit() && interaction.customId === 'verify_modal') {
        const username = interaction.fields.getTextInputValue('username_input');
        const pin = interaction.fields.getTextInputValue('pin_input');
        
        // Read DB
        let db = {};
        try {
            if (fs.existsSync(DB_FILE)) {
                db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            }
        } catch (e) { console.error("DB Read Error", e); }

        const user = db[username];

        if (user && user.pin === pin) {
            // SUCCESS LOGIC
            db[username].verified = true;
            db[username].discordId = interaction.user.id;
            fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

            // Update Discord Member
            const member = interaction.member;
            try {
                // Change Nickname
                const newNick = `${interaction.user.username} | ${username}`;
                if (newNick.length <= 32) {
                    await member.setNickname(newNick);
                }
                
                // Give 'Verified' Role
                let role = interaction.guild.roles.cache.find(r => r.name === "Verified User");
                if (!role) {
                    role = await interaction.guild.roles.create({
                        name: "Verified User",
                        color: 0x00FF00,
                        permissions: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.Connect]
                    });
                }
                await member.roles.add(role);
                
                await interaction.reply({ content: `✅ **Access Granted!** Welcome, ${username}.`, ephemeral: true });

            } catch (err) {
                console.error(err);
                await interaction.reply({ content: "✅ Verified on Site! (Bot lacks permissions to update Nickname/Role, please check Hierarchy)", ephemeral: true });
            }

        } else {
            // FAIL
            await interaction.reply({ content: "❌ **Access Denied:** Invalid Username or PIN.", ephemeral: true });
        }
    }
    
    // 3. ADMIN SLASH COMMAND (/users)
    if (interaction.isChatInputCommand() && interaction.commandName === 'users') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({ content: "⛔ Admin only.", ephemeral: true });
        }

        const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        let content = "ROBLOX EXECUTOR USER DATABASE
=============================
";
        Object.keys(db).forEach(u => {
            content += `
User: ${u}
Pin: ${db[u].pin}
Verified: ${db[u].verified ? 'YES' : 'NO'}
DiscordID: ${db[u].discordId || 'N/A'}
----------------
`;
        });

        const buffer = Buffer.from(content, 'utf-8');
        await interaction.reply({ 
            content: "📂 **User Database Generated:**", 
            files: [{ attachment: buffer, name: 'users_db.txt' }] 
        });
    }
});

// REGISTER SLASH COMMANDS ON STARTUP
client.on('ready', async () => {
    const data = [{
        name: 'users',
        description: 'Download users.txt (Admin Only)',
    }];
    await client.application.commands.set(data);
});

client.login(DISCORD_TOKEN);

app.listen(PORT, () => {
    console.log(`✅ BACKEND LISTENING ON PORT ${PORT}`);
});
