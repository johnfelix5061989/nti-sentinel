const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Sequelize = require('sequelize');
const cron = require('node-cron');
const { createObjectCsvWriter } = require('csv-writer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Op } = require('sequelize');

// --- Configuração ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

// --- Banco de Dados ---
const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: './database.sqlite',
    logging: false
});

const Ticket = sequelize.define('Ticket', {
    solicitante: Sequelize.STRING,
    matricula: Sequelize.STRING,
    setor: Sequelize.STRING,
    problema: Sequelize.STRING,
    prioridade: { type: Sequelize.STRING, defaultValue: 'Normal' },
    status: { type: Sequelize.STRING, defaultValue: 'aberto' },
    solucao: Sequelize.TEXT,
    analista: Sequelize.STRING,
    tempo_resolucao: Sequelize.STRING,
    data_fechamento: Sequelize.DATE,
    timestamp: { type: Sequelize.DATE, defaultValue: Sequelize.NOW }
});

sequelize.sync().then(() => console.log("💾 Banco de dados pronto e sincronizado."));

function calcularTempo(inicio, fim) {
    const diff = new Date(fim) - new Date(inicio);
    const horas = Math.floor(diff / (1000 * 60 * 60));
    const minutos = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return `${horas}h ${minutos}m`;
}

// --- ROTAS DE TICKETS ---

app.post('/api/ticket', async (req, res) => {
    try {
        const { solicitante, matricula, setor, problema } = req.body;
        const setoresCriticos = ["CICCE/OPERAÇÕES", "SALA DE CRISES", "CALL CENTER", "DESPACHO"];
        let prioridade = setoresCriticos.includes(setor.toUpperCase()) ? 'Alta' : 'Normal';
        
        console.log(`📝 Novo: ${solicitante} | Setor: ${setor} | Prioridade: ${prioridade}`);
        const novoTicket = await Ticket.create({ solicitante, matricula, setor, problema, prioridade });
        io.emit('novo_chamado', novoTicket);
        res.json({ success: true, ticket: novoTicket });
    } catch (error) { res.status(500).json({ error: 'Erro ao criar ticket' }); }
});

app.post('/api/ticket/update', async (req, res) => {
    const { id, status, solucao, analista } = req.body;
    const ticket = await Ticket.findByPk(id);
    if(ticket) {
        const dadosUpdate = { status, solucao, analista: analista || 'Operador NTI' };
        if(status.includes('solucionado') || status === 'n3') {
            dadosUpdate.data_fechamento = new Date();
            dadosUpdate.tempo_resolucao = calcularTempo(ticket.timestamp, dadosUpdate.data_fechamento);
        }
        await ticket.update(dadosUpdate);
        io.emit('atualiza_chamado', { id, status });
        res.json({ success: true });
    } else { res.status(404).json({ error: 'Ticket não encontrado' }); }
});

app.post('/api/ticket/auto', async (req, res) => {
    const { solicitante, problema } = req.body;
    await Ticket.create({
        solicitante: solicitante || "Usuário Web",
        matricula: "CHATBOT",
        setor: "Autoatendimento",
        problema: problema,
        status: 'auto_solucionado',
        solucao: 'Resolvido via Chatbot',
        analista: 'Sistema (Bot)',
        data_fechamento: new Date(),
        tempo_resolucao: '0h 0m'
    });
    res.json({ success: true });
});

app.get('/api/tickets/ativos', async (req, res) => {
    const tickets = await Ticket.findAll({ where: { status: 'aberto' } });
    res.json(tickets);
});

app.get('/api/stats/hoje', async (req, res) => {
    try {
        const inicioDia = new Date(); inicioDia.setHours(0,0,0,0);
        const tickets = await Ticket.findAll({ where: { timestamp: { [Op.gte]: inicioDia } }, order: [['timestamp', 'DESC']] });

        const listHumanos = tickets.filter(t => t.status === 'solucionado');
        const listRobo = tickets.filter(t => t.status === 'auto_solucionado');
        const listN3 = tickets.filter(t => t.status === 'n3');

        const categorias = {};
        tickets.forEach(t => {
            let cat = t.setor === 'Autoatendimento' ? 'Robô' : t.problema.split(']')[0].replace('[','').trim();
            categorias[cat] = (categorias[cat] || 0) + 1;
        });

        res.json({ 
            total: tickets.length,
            resolvidos_humanos: listHumanos.length,
            resolvidos_robo: listRobo.length,
            escalados_n3: listN3.length,
            grafico: categorias,
            detalhes: { total: tickets, humanos: listHumanos, robo: listRobo, n3: listN3 } 
        });
    } catch (e) { res.status(500).json({ error: "Erro stats" }); }
});

// --- ROTAS DO HISTÓRICO E ARQUIVOS ---

// 1. Busca no Banco (Tickets Recentes/Ativos)
app.get('/api/historico', async (req, res) => {
    try {
        const { inicio, fim, status, busca } = req.query;
        const where = {};
        if (inicio && fim) {
            const dataFim = new Date(fim); dataFim.setHours(23,59,59,999);
            where.timestamp = { [Op.between]: [new Date(inicio), dataFim] };
        }
        if (status && status !== 'todos') where.status = status;
        if (busca) {
            where[Op.or] = [
                { solicitante: { [Op.like]: `%${busca}%` } },
                { matricula: { [Op.like]: `%${busca}%` } },
                { problema: { [Op.like]: `%${busca}%` } }
            ];
        }
        const tickets = await Ticket.findAll({ where, order: [['timestamp', 'DESC']] });
        res.json(tickets);
    } catch (e) { res.status(500).json([]); }
});

// 2. Exportar CSV do Banco Atual
app.get('/api/exportar', async (req, res) => {
    const { inicio, fim } = req.query;
    const tickets = await Ticket.findAll({
        where: { timestamp: { [Op.between]: [new Date(inicio), new Date(fim + 'T23:59:59')] } }
    });
    const csvWriter = createObjectCsvWriter({
        path: './temp_export.csv',
        header: [
            {id: 'id', title: 'ID'}, {id: 'timestamp', title: 'ABERTURA'}, 
            {id: 'solicitante', title: 'SOLICITANTE'}, {id: 'setor', title: 'SETOR'}, 
            {id: 'problema', title: 'PROBLEMA'}, {id: 'status', title: 'STATUS'}
        ]
    });
    await csvWriter.writeRecords(tickets.map(t => t.dataValues));
    res.download('./temp_export.csv', `Relatorio_Parcial_${inicio}.csv`);
});

// 3. LISTAR ARQUIVOS DE LOG (NOVO!)
app.get('/api/logs-list', (req, res) => {
    const logRoot = path.join(__dirname, 'logs');
    if (!fs.existsSync(logRoot)) return res.json([]);

    const anos = fs.readdirSync(logRoot);
    let arquivos = [];

    anos.forEach(ano => {
        const pastaAno = path.join(logRoot, ano);
        if(fs.lstatSync(pastaAno).isDirectory()){
            const files = fs.readdirSync(pastaAno).filter(f => f.endsWith('.csv'));
            files.forEach(f => {
                arquivos.push({ ano, arquivo: f });
            });
        }
    });
    // Ordena do mais novo para o mais velho
    res.json(arquivos.reverse());
});

// 4. BAIXAR ARQUIVO DE LOG (NOVO!)
app.get('/api/logs/download/:ano/:arquivo', (req, res) => {
    const { ano, arquivo } = req.params;
    const file = path.join(__dirname, 'logs', ano, arquivo);
    if(fs.existsSync(file)) res.download(file);
    else res.status(404).send('Arquivo não encontrado');
});

// --- ROTINA DE TURNO (07:00) ---
cron.schedule('0 7 * * *', async () => {
    console.log('⏰ Turno 07h: Arquivando tickets resolvidos...');
    const hoje = new Date();
    const diaFormatado = hoje.toISOString().split('T')[0];
    const ticketsParaArquivar = await Ticket.findAll({
        where: { status: { [Op.or]: ['solucionado', 'auto_solucionado'] } }
    });
    if (ticketsParaArquivar.length > 0) {
        const dir = path.join(__dirname, 'logs', String(hoje.getFullYear()));
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, `SENTINEL_TURNO_${diaFormatado}.csv`);
        
        const csvWriter = createObjectCsvWriter({
            path: filePath,
            header: [
                {id: 'id', title: 'ID'}, {id: 'timestamp', title: 'DATA_ABERTURA'}, 
                {id: 'data_fechamento', title: 'DATA_FECHAMENTO'}, {id: 'solicitante', title: 'SOLICITANTE'},
                {id: 'matricula', title: 'MATRICULA'}, {id: 'setor', title: 'SETOR'},
                {id: 'problema', title: 'OCORRENCIA'}, {id: 'prioridade', title: 'PRIORIDADE'},
                {id: 'status', title: 'STATUS'}, {id: 'analista', title: 'ANALISTA'},
                {id: 'tempo_resolucao', title: 'TEMPO_RESOLUCAO'}, {id: 'solucao', title: 'OBSERVACAO'}
            ]
        });
        await csvWriter.writeRecords(ticketsParaArquivar.map(t => t.dataValues));
        await Ticket.destroy({ where: { status: { [Op.or]: ['solucionado', 'auto_solucionado'] } } });
        console.log(`✅ ${ticketsParaArquivar.length} tickets arquivados em CSV.`);
        io.emit('refresh_dashboard'); 
    }
});

const PORT = 3000;
server.listen(PORT, () => console.log(`🔥 Sentinel V2 rodando na porta ${PORT}`));