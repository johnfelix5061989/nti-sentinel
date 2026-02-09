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

// ... (início do arquivo igual)

// 1. Atualize a Tabela no Banco
const Ticket = sequelize.define('Ticket', {
    solicitante: Sequelize.STRING,
    matricula: Sequelize.STRING, // <--- NOVO CAMPO
    setor: Sequelize.STRING,
    problema: Sequelize.STRING,
    status: { type: Sequelize.STRING, defaultValue: 'aberto' },
    solucao: Sequelize.TEXT,
    timestamp: { type: Sequelize.DATE, defaultValue: Sequelize.NOW }
});

// ... (código do meio igual)

// 2. Atualize a API que recebe o chamado
app.post('/api/ticket', async (req, res) => {
    try {
        const { solicitante, matricula, setor, problema } = req.body; // <--- Recebe matricula
        console.log(`📝 Novo chamado: ${solicitante} (${matricula})`);
        
        const novoTicket = await Ticket.create({ solicitante, matricula, setor, problema });
        
        io.emit('novo_chamado', novoTicket);
        res.json({ success: true, ticket: novoTicket });
    } catch (error) {
        console.error("Erro:", error);
        res.status(500).json({ error: 'Erro ao abrir chamado' });
    }
});

// ... (resto do arquivo igual)

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

app.get('/api/stats/hoje', async (req, res) => {
    try {
        // Ordena por data (mais recentes primeiro)
        const tickets = await Ticket.findAll({ order: [['timestamp', 'DESC']] });
        
        // Listas Filtradas
        const listTotal = tickets;
        const listHumanos = tickets.filter(t => t.status === 'solucionado');
        const listRobo = tickets.filter(t => t.status === 'auto_solucionado');
        const listN3 = tickets.filter(t => t.status === 'n3');

        // Agrupamento para o gráfico (Mantido igual)
        const categorias = {};
        tickets.forEach(t => {
            let cat = t.setor === 'Autoatendimento' ? 'Robô (Auto)' : t.problema.split(']')[0].replace('[','').trim();
            if(cat.length > 20) cat = "Geral"; 
            categorias[cat] = (categorias[cat] || 0) + 1;
        });

        res.json({
            // Contadores (KPIs)
            total: listTotal.length,
            resolvidos_humanos: listHumanos.length,
            resolvidos_robo: listRobo.length,
            escalados_n3: listN3.length,
            
            // Listas para o Modal (NOVO!)
            detalhes: {
                total: listTotal,
                humanos: listHumanos,
                robo: listRobo,
                n3: listN3
            },

            // Gráfico
            grafico: categorias
        });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao gerar estatisticas' });
    }
});

// --- 5. Start ---
const PORT = 3000;
server.listen(PORT, () => {
    console.log('------------------------------------------------');
    console.log(`🚀 NTI Sentinel rodando em http://localhost:${PORT}`);
    console.log(`📱 Usuário: http://localhost:${PORT}/index.html`);
    console.log(`🖥️ Dashboard: http://localhost:${PORT}/dashboard.html`);
    console.log(`📊 Gestor: http://localhost:${PORT}/gestor.html`);
    console.log('------------------------------------------------');
});