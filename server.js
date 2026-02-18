const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Sequelize = require('sequelize');
const cron = require('node-cron');
const { createObjectCsvWriter } = require('csv-writer');
const fs = require('fs');
const { Op } = require('sequelize');

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

// Modelo do Ticket (Tabela)
const Ticket = sequelize.define('Ticket', {
    solicitante: Sequelize.STRING,
    matricula: Sequelize.STRING, 
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

// ROTA 1: CRIAR CHAMADO (Apenas uma versão correta)
app.post('/api/ticket', async (req, res) => {
    try {
        const { solicitante, matricula, setor, problema } = req.body;
        console.log(`📝 Novo chamado: ${solicitante} (Mat: ${matricula})`);
        
        const novoTicket = await Ticket.create({ solicitante, matricula, setor, problema });
        
        io.emit('novo_chamado', novoTicket);
        res.json({ success: true, ticket: novoTicket });
    } catch (error) {
        console.error("Erro ao criar ticket:", error);
        res.status(500).json({ error: 'Erro ao abrir chamado' });
    }
});

// ROTA 2: ATUALIZAR STATUS (Resolver/Escalar)
app.post('/api/ticket/update', async (req, res) => {
    const { id, status, solucao } = req.body;
    await Ticket.update({ status, solucao }, { where: { id } });
    
    // Busca o ticket atualizado para pegar os dados novos
    const ticketAtualizado = await Ticket.findByPk(id);
    
    io.emit('atualiza_chamado', { id, status });
    res.json({ success: true });
});

// ROTA 3: LISTAR ATIVOS (Para o Dashboard)
app.get('/api/tickets/ativos', async (req, res) => {
    const tickets = await Ticket.findAll({ where: { status: 'aberto' } });
    res.json(tickets);
});

// ROTA 4: CHATBOT (Autoatendimento)
app.post('/api/ticket/auto', async (req, res) => {
    try {
        const { solicitante, problema } = req.body;
        
        await Ticket.create({ 
            solicitante: solicitante || "Usuário Web", 
            matricula: "CHATBOT",
            setor: "Autoatendimento", 
            problema: problema,
            status: 'auto_solucionado', 
            solucao: 'Resolvido pelo usuário via Chatbot'
        });
        
        console.log(`🤖 Autoatendimento registrado: ${problema}`);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao logar autoatendimento' });
    }
});

// ROTA 5: ESTATÍSTICAS GESTOR (Com filtro de Hoje corrigido)
app.get('/api/stats/hoje', async (req, res) => {
    try {
        // Define o início do dia de hoje (00:00:00) para filtrar
        const inicioDia = new Date();
        inicioDia.setHours(0,0,0,0);

        // Busca tickets de hoje em diante
        const tickets = await Ticket.findAll({
            where: { 
                timestamp: { [Op.gte]: inicioDia } 
            },
            order: [['timestamp', 'DESC']]
        });
        
        // Listas Filtradas
        const listTotal = tickets;
        const listHumanos = tickets.filter(t => t.status === 'solucionado');
        const listRobo = tickets.filter(t => t.status === 'auto_solucionado');
        const listN3 = tickets.filter(t => t.status === 'n3');

        // Agrupamento para o gráfico
        const categorias = {};
        tickets.forEach(t => {
            let cat = t.setor === 'Autoatendimento' ? 'Robô (Auto)' : t.problema.split(']')[0].replace('[','').trim();
            if(cat.length > 20) cat = "Geral"; 
            categorias[cat] = (categorias[cat] || 0) + 1;
        });

        res.json({
            // Contadores
            total: listTotal.length,
            resolvidos_humanos: listHumanos.length,
            resolvidos_robo: listRobo.length,
            escalados_n3: listN3.length,
            
            // Detalhes para o Modal
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
        console.error(error);
        res.status(500).json({ error: 'Erro ao gerar estatisticas' });
    }
});

// --- 4. Rotina de Reset Diário (07:00 AM) ---
cron.schedule('0 7 * * *', async () => {
    console.log('⏰ Executando rotina de limpeza das 07h...');
    const hoje = new Date().toISOString().split('T')[0];
    const tickets = await Ticket.findAll();
    
    if (tickets.length > 0) {
        if (!fs.existsSync('./logs')) fs.mkdirSync('./logs');
        const csvWriter = createObjectCsvWriter({
            path: `./logs/relatorio_${hoje}.csv`,
            header: [
                {id: 'id', title: 'ID'},
                {id: 'solicitante', title: 'SOLICITANTE'},
                {id: 'matricula', title: 'MATRICULA'},
                {id: 'problema', title: 'PROBLEMA'},
                {id: 'status', title: 'STATUS'},
                {id: 'solucao', title: 'SOLUCAO'},
                {id: 'createdAt', title: 'DATA'}
            ]
        });
        await csvWriter.writeRecords(tickets.map(t => t.dataValues));
        
        // Limpa a tabela
        await Ticket.destroy({ where: {}, truncate: true });
        io.emit('reset_diario');
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