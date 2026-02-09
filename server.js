const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Sequelize = require('sequelize');
const cron = require('node-cron');
const { createObjectCsvWriter } = require('csv-writer');
const fs = require('fs');

// --- 1. Configuração do Servidor ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

// --- 2. Banco de Dados (SQLite) ---
const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: './database.sqlite',
    logging: false
});

const Ticket = sequelize.define('Ticket', {
    solicitante: Sequelize.STRING,
    setor: Sequelize.STRING,
    problema: Sequelize.STRING,
    status: { type: Sequelize.STRING, defaultValue: 'aberto' },
    solucao: Sequelize.TEXT,
    timestamp: { type: Sequelize.DATE, defaultValue: Sequelize.NOW }
});

// Inicializa o banco
sequelize.sync().then(() => {
    console.log("💾 Banco de dados sincronizado.");
});

// --- 3. Rotas e APIs ---
app.post('/api/ticket', async (req, res) => {
    try {
        const { solicitante, setor, problema } = req.body;
        console.log(`📝 Novo chamado recebido de: ${solicitante}`);
        const novoTicket = await Ticket.create({ solicitante, setor, problema });
        io.emit('novo_chamado', novoTicket);
        res.json({ success: true, ticket: novoTicket });
    } catch (error) {
        console.error("Erro ao criar ticket:", error);
        res.status(500).json({ error: 'Erro ao abrir chamado' });
    }
});

app.post('/api/ticket/update', async (req, res) => {
    const { id, status, solucao } = req.body;
    await Ticket.update({ status, solucao }, { where: { id } });
    io.emit('atualiza_chamado', { id, status });
    res.json({ success: true });
});

app.get('/api/tickets/ativos', async (req, res) => {
    const tickets = await Ticket.findAll({ where: { status: 'aberto' } });
    res.json(tickets);
});

// --- 4. Rotina de Reset (07:00 AM) ---
cron.schedule('0 7 * * *', async () => {
    console.log('⏰ Executando rotina das 07h...');
    const hoje = new Date().toISOString().split('T')[0];
    const tickets = await Ticket.findAll();
    
    if (tickets.length > 0) {
        if (!fs.existsSync('./logs')) fs.mkdirSync('./logs');
        const csvWriter = createObjectCsvWriter({
            path: `./logs/relatorio_${hoje}.csv`,
            header: [
                {id: 'id', title: 'ID'},
                {id: 'solicitante', title: 'SOLICITANTE'},
                {id: 'problema', title: 'PROBLEMA'},
                {id: 'status', title: 'STATUS'},
                {id: 'solucao', title: 'SOLUCAO'},
                {id: 'createdAt', title: 'DATA'}
            ]
        });
        await csvWriter.writeRecords(tickets.map(t => t.dataValues));
        await Ticket.destroy({ where: {}, truncate: true });
        io.emit('reset_diario');
    }
});

// Rota para logar resoluções do Chatbot (Sem aparecer no Dashboard)
app.post('/api/ticket/auto', async (req, res) => {
    try {
        const { solicitante, problema } = req.body;
        
        // Cria o ticket já como 'auto-solucionado'
        await Ticket.create({ 
            solicitante: solicitante || "Anônimo (Chatbot)", 
            setor: "Autoatendimento", 
            problema: problema,
            status: 'auto_solucionado', // Status especial
            solucao: 'Resolvido pelo usuário via Chatbot (Nível 0)'
        });
        
        console.log(`🤖 Autoatendimento registrado: ${problema}`);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao logar autoatendimento' });
    }
});

// --- 5. Start ---
const PORT = 3000;
server.listen(PORT, () => {
    console.log('------------------------------------------------');
    console.log(`🚀 NTI Sentinel rodando em http://localhost:${PORT}`);
    console.log(`📱 Usuário: http://localhost:${PORT}/index.html`);
    console.log(`🖥️ Dashboard: http://localhost:${PORT}/dashboard.html`);
    console.log('------------------------------------------------');
});