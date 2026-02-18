const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Sequelize = require('sequelize');
const cron = require('node-cron');
const { createObjectCsvWriter } = require('csv-writer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto'); // Para integridade (Hash)
const { Op } = require('sequelize');

// --- Configuração ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

// --- Banco de Dados (Persistência) ---
const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: './database.sqlite', // Agora os dados ficam aqui permanentemente
    logging: false
});

// Modelo Robusto
const Ticket = sequelize.define('Ticket', {
    solicitante: Sequelize.STRING,
    matricula: Sequelize.STRING,
    setor: Sequelize.STRING,
    problema: Sequelize.STRING,
    prioridade: { type: Sequelize.STRING, defaultValue: 'Normal' }, // Novo
    status: { type: Sequelize.STRING, defaultValue: 'aberto' },
    solucao: Sequelize.TEXT,
    analista: Sequelize.STRING, // Novo: Quem resolveu
    tempo_resolucao: Sequelize.STRING, // Novo: Calculado
    data_fechamento: Sequelize.DATE, // Novo
    timestamp: { type: Sequelize.DATE, defaultValue: Sequelize.NOW }
});

sequelize.sync().then(() => console.log("💾 Banco de dados persistente pronto."));

// --- Funções Auxiliares ---

// Calcula tempo de resolução (ex: "2h 30m")
function calcularTempo(inicio, fim) {
    const diff = new Date(fim) - new Date(inicio);
    const horas = Math.floor(diff / (1000 * 60 * 60));
    const minutos = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return `${horas}h ${minutos}m`;
}

// Gera Hash SHA256 para integridade
function gerarHashArquivo(caminhoArquivo) {
    const fileBuffer = fs.readFileSync(caminhoArquivo);
    const hashSum = crypto.createHash('sha256');
    hashSum.update(fileBuffer);
    return hashSum.digest('hex');
}

// --- Rotas Operacionais ---

// 1. Criar Chamado
app.post('/api/ticket', async (req, res) => {
    try {
        const { solicitante, matricula, setor, problema } = req.body;
        // Define prioridade baseada em palavras-chave (Exemplo simples)
        let prioridade = 'Normal';
        if(problema.toLowerCase().includes('internet') || problema.toLowerCase().includes('servidor')) prioridade = 'Alta';

        const novoTicket = await Ticket.create({ solicitante, matricula, setor, problema, prioridade });
        io.emit('novo_chamado', novoTicket);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: 'Erro ao criar' }); }
});

// 2. Atualizar/Resolver (Com cálculo de tempo e analista)
app.post('/api/ticket/update', async (req, res) => {
    const { id, status, solucao, analista } = req.body;
    
    const ticket = await Ticket.findByPk(id);
    if(ticket) {
        const dadosUpdate = { status, solucao, analista: analista || 'Operador NTI' };
        
        // Se foi resolvido/fechado agora
        if(status === 'solucionado' || status === 'auto_solucionado' || status === 'n3') {
            dadosUpdate.data_fechamento = new Date();
            dadosUpdate.tempo_resolucao = calcularTempo(ticket.timestamp, dadosUpdate.data_fechamento);
        }

        await ticket.update(dadosUpdate);
        io.emit('atualiza_chamado', { id, status });
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Ticket não encontrado' });
    }
});

app.post('/api/ticket/auto', async (req, res) => {
    // Rota do Chatbot (Autoatendimento)
    const { solicitante, problema } = req.body;
    const agora = new Date();
    await Ticket.create({
        solicitante: solicitante || "Usuário Web",
        matricula: "CHATBOT",
        setor: "Autoatendimento",
        problema: problema,
        status: 'auto_solucionado',
        solucao: 'Resolvido via Chatbot',
        analista: 'Sistema (Bot)',
        data_fechamento: agora,
        tempo_resolucao: '0h 0m'
    });
    res.json({ success: true });
});

app.get('/api/tickets/ativos', async (req, res) => {
    const tickets = await Ticket.findAll({ where: { status: 'aberto' } });
    res.json(tickets);
});

// --- API DE ESTATÍSTICAS (Gestor) ---
app.get('/api/stats/hoje', async (req, res) => {
    const inicioDia = new Date(); inicioDia.setHours(0,0,0,0);
    const tickets = await Ticket.findAll({ where: { timestamp: { [Op.gte]: inicioDia } }, order: [['timestamp', 'DESC']] });
    // ... (mesma lógica de agrupamento do código anterior) ...
    // Para economizar espaço aqui, mantive a lógica de contagem simples
    const total = tickets.length;
    const resolvidos = tickets.filter(t => t.status === 'solucionado').length;
    const auto = tickets.filter(t => t.status === 'auto_solucionado').length;
    const n3 = tickets.filter(t => t.status === 'n3').length;
    
    // Gráfico simples
    const categorias = {};
    tickets.forEach(t => {
        let cat = t.setor === 'Autoatendimento' ? 'Robô' : t.problema.split(']')[0].replace('[','').trim();
        categorias[cat] = (categorias[cat] || 0) + 1;
    });

    res.json({ total, resolvidos_humanos: resolvidos, resolvidos_robo: auto, escalados_n3: n3, grafico: categorias, detalhes: { total: tickets } });
});

// --- MÓDULO HISTÓRICO E EXPORTAÇÃO ---

// 1. Busca Avançada (Histórico)
app.get('/api/historico', async (req, res) => {
    try {
        const { inicio, fim, status, busca } = req.query;
        
        const where = {};
        
        // Filtro de Data
        if (inicio && fim) {
            const dataFim = new Date(fim); dataFim.setHours(23,59,59,999);
            where.timestamp = { [Op.between]: [new Date(inicio), dataFim] };
        } else {
            // Padrão: Últimos 7 dias
            const d = new Date(); d.setDate(d.getDate() - 7);
            where.timestamp = { [Op.gte]: d };
        }

        // Filtro de Status
        if (status && status !== 'todos') where.status = status;

        // Busca Textual (Nome, Matrícula ou Problema)
        if (busca) {
            where[Op.or] = [
                { solicitante: { [Op.like]: `%${busca}%` } },
                { matricula: { [Op.like]: `%${busca}%` } },
                { problema: { [Op.like]: `%${busca}%` } }
            ];
        }

        const tickets = await Ticket.findAll({ where, order: [['timestamp', 'DESC']] });
        res.json(tickets);
    } catch (e) { console.error(e); res.status(500).json([]); }
});

// 2. Exportação Sob Demanda (CSV)
app.get('/api/exportar', async (req, res) => {
    // Reutiliza a lógica de busca para exportar o que foi filtrado
    // ... (Implementação simplificada: exporta tudo do período solicitado)
    const { inicio, fim } = req.query;
    const tickets = await Ticket.findAll({
        where: { timestamp: { [Op.between]: [new Date(inicio), new Date(fim + 'T23:59:59')] } }
    });

    const csvWriter = createObjectCsvWriter({
        path: './temp_export.csv',
        header: [
            {id: 'id', title: 'ID'}, {id: 'timestamp', title: 'ABERTURA'}, {id: 'data_fechamento', title: 'FECHAMENTO'},
            {id: 'solicitante', title: 'SOLICITANTE'}, {id: 'matricula', title: 'MATRICULA'},
            {id: 'problema', title: 'PROBLEMA'}, {id: 'status', title: 'STATUS'},
            {id: 'analista', title: 'ANALISTA'}, {id: 'tempo_resolucao', title: 'TEMPO_RESOLUCAO'}
        ]
    });

    await csvWriter.writeRecords(tickets.map(t => t.dataValues));
    res.download('./temp_export.csv', `Relatorio_Sentinel_${inicio}_a_${fim}.csv`);
});

// --- 4. Rotina de Arquivamento Seletivo (07:00 AM) ---
cron.schedule('0 7 * * *', async () => {
    console.log('⏰ Executando rotina de passagem de turno (07h)...');
    
    const hoje = new Date();
    const ano = hoje.getFullYear();
    const diaFormatado = hoje.toISOString().split('T')[0];

    // 1. Filtra APENAS o que foi finalizado (Humanos ou Robô)
    // O que for 'aberto' ou 'n3' NÃO entra aqui
    const ticketsParaArquivar = await Ticket.findAll({
        where: {
            status: { [Op.or]: ['solucionado', 'auto_solucionado'] }
        }
    });
    
    if (ticketsParaArquivar.length > 0) {
        // Cria pastas se não existirem
        const dir = path.join(__dirname, 'logs', String(ano));
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        
        const filePath = path.join(dir, `SENTINEL_TURNO_${diaFormatado}.csv`);

        // 2. Gera o CSV apenas com os finalizados
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
        
        // 3. Hash de Integridade
        const fileBuffer = fs.readFileSync(filePath);
        const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        fs.writeFileSync(`${filePath}.sha256`, hash);

        // 4. DELETA APENAS OS FINALIZADOS DO BANCO
        // Os chamados 'aberto' e 'n3' continuam vivos no banco SQLite
        await Ticket.destroy({
            where: {
                status: { [Op.or]: ['solucionado', 'auto_solucionado'] }
            }
        });

        console.log(`✅ Turno fechado. ${ticketsParaArquivar.length} chamados arquivados.`);
        
        // Avisa o front-end para atualizar a lista (remove os que sumiram)
        io.emit('refresh_dashboard'); 
    } else {
        console.log('ℹ️ Nenhum chamado finalizado para arquivar hoje.');
    }
});

const PORT = 3000;
server.listen(PORT, () => console.log(`🔥 Sentinel V2 rodando na porta ${PORT}`));