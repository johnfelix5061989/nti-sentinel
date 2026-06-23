const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Sequelize = require('sequelize');
const cron = require('node-cron');
const { createObjectCsvWriter } = require('csv-writer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcrypt');
const session = require('express-session');
const { Op } = require('sequelize');

// --- Configuração ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Sessão ---
app.use(session({
    secret: 'nti-sentinel-secret-2026-trocar-em-producao',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 } // 8 horas
}));

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

const User = sequelize.define('User', {
    nome: { type: Sequelize.STRING, allowNull: false },
    username: { type: Sequelize.STRING, allowNull: false, unique: true },
    passwordHash: { type: Sequelize.STRING, allowNull: false },
    role: { type: Sequelize.ENUM('dev', 'gestor', 'operador'), allowNull: false, defaultValue: 'gestor' },
    status: { type: Sequelize.ENUM('pendente', 'aprovado'), allowNull: false, defaultValue: 'pendente' },
    criadoEm: { type: Sequelize.DATE, defaultValue: Sequelize.NOW }
});

// --- Passport ---
app.use(passport.initialize());
app.use(passport.session());

passport.use(new LocalStrategy(
    { usernameField: 'username', passwordField: 'senha' },
    async (username, senha, done) => {
        try {
            const user = await User.findOne({ where: { username } });
            if (!user) return done(null, false, { message: 'Usuário inexistente.' });
            if (user.status !== 'aprovado') return done(null, false, { message: 'Cadastro pendente de aprovação pelo Dev.' });
            const ok = await bcrypt.compare(senha, user.passwordHash);
            if (!ok) return done(null, false, { message: 'Senha incorreta.' });
            return done(null, user);
        } catch (e) { return done(e); }
    }
));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findByPk(id);
        done(null, user ? {
            id: user.id, nome: user.nome, username: user.username,
            role: user.role, status: user.status
        } : null);
    } catch (e) { done(e); }
});

// --- Middlewares de Acesso ---
function isAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    return res.status(401).json({ error: 'Não autenticado.' });
}
function isDev(req, res, next) {
    if (req.isAuthenticated() && req.user.role === 'dev') return next();
    return res.status(403).json({ error: 'Acesso restrito ao Dev.' });
}
// Quem gerencia usuários: Dev (tudo) ou Operador (só gestor/operador, nunca dev)
function isManager(req, res, next) {
    if (req.isAuthenticated() && (req.user.role === 'dev' || req.user.role === 'operador')) return next();
    return res.status(403).json({ error: 'Acesso restrito a quem gerencia usuários.' });
}
function isStaff(req, res, next) {
    if (req.isAuthenticated() && (req.user.role === 'dev' || req.user.role === 'gestor' || req.user.role === 'operador')) return next();
    return res.status(403).json({ error: 'Acesso restrito a usuários autorizados.' });
}

// --- Seed do Dev inicial ---
async function seedDev() {
    const count = await User.count();
    if (count === 0) {
        const hash = await bcrypt.hash('nti2026', 10);
        await User.create({
            nome: 'Administrador NTI', username: 'admin',
            passwordHash: hash, role: 'dev', status: 'aprovado'
        });
        console.log('🔐 Dev inicial criado -> usuario: admin | senha: nti2026 (altere apos o primeiro login)');
    }
}

sequelize.sync().then(async () => {
    console.log("💾 Banco de dados pronto e sincronizado.");
    await seedDev();
});

function calcularTempo(inicio, fim) {
    const diff = new Date(fim) - new Date(inicio);
    const horas = Math.floor(diff / (1000 * 60 * 60));
    const minutos = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return `${horas}h ${minutos}m`;
}

// ====================================================
//   ROTAS DE AUTENTICAÇÃO
// ====================================================

// Cadastro livre do Gestor ou Operador (fica pendente até o Dev/Operador aprovar)
app.post('/auth/register', async (req, res) => {
    try {
        const { nome, username, senha, role } = req.body;
        if (!nome || !username || !senha) return res.status(400).json({ error: 'Preencha nome, usuário e senha.' });
        const existe = await User.findOne({ where: { username } });
        if (existe) return res.status(409).json({ error: 'Esse usuário já existe.' });
        const hash = await bcrypt.hash(senha, 10);
        const roleFinal = role === 'operador' ? 'operador' : 'gestor';
        await User.create({ nome, username, passwordHash: hash, role: roleFinal, status: 'pendente' });
        res.json({ success: true, message: 'Cadastro realizado! Aguarde a aprovação para acessar.' });
    } catch (e) { res.status(500).json({ error: 'Erro ao cadastrar.' }); }
});

// Login (Dev e Gestor)
app.post('/auth/login', (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
        if (err) return next(err);
        if (!user) return res.status(401).json({ error: info.message || 'Credenciais inválidas.' });
        req.login(user, (err) => {
            if (err) return next(err);
            res.json({
                success: true,
                user: { id: user.id, nome: user.nome, username: user.username, role: user.role, status: user.status }
            });
        });
    })(req, res, next);
});

app.post('/auth/logout', (req, res) => {
    req.logout(() => res.json({ success: true }));
});

app.get('/auth/me', (req, res) => {
    if (req.isAuthenticated()) return res.json({ authenticated: true, user: req.user });
    res.json({ authenticated: false });
});

// Gestor de usuários (Dev ou Operador): listar usuários
// Operador não enxerga contas Dev (não pode mexer em nada de dev)
app.get('/auth/users', isManager, async (req, res) => {
    let where = {};
    if (req.user.role !== 'dev') where.role = { [Op.ne]: 'dev' };
    const users = await User.findAll({ where, order: [['status', 'ASC'], ['criadoEm', 'DESC']] });
    res.json(users.map(u => ({
        id: u.id, nome: u.nome, username: u.username,
        role: u.role, status: u.status, criadoEm: u.criadoEm
    })));
});

// Aprovar cadastro pendente (Dev ou Operador)
app.post('/auth/approve/:id', isManager, async (req, res) => {
    const u = await User.findByPk(req.params.id);
    if (!u) return res.status(404).json({ error: 'Usuário não encontrado.' });
    if (u.role === 'dev' && req.user.role !== 'dev') return res.status(403).json({ error: 'Operador não pode aprovar Dev.' });
    await u.update({ status: 'aprovado' });
    res.json({ success: true });
});

// Recusar / remover usuário (Dev ou Operador). Operador não remove Dev.
app.post('/auth/reject/:id', isManager, async (req, res) => {
    const u = await User.findByPk(req.params.id);
    if (!u) return res.status(404).json({ error: 'Usuário não encontrado.' });
    if (u.username === 'admin') return res.status(400).json({ error: 'O admin inicial não pode ser removido.' });
    if (u.role === 'dev' && req.user.role !== 'dev') return res.status(403).json({ error: 'Operador não pode remover Dev.' });
    await u.destroy();
    res.json({ success: true });
});

// Criar usuário-chave já aprovado (Dev ou Operador)
// Dev pode criar qualquer função; Operador só pode criar gestor ou operador
app.post('/auth/create', isManager, async (req, res) => {
    try {
        const { nome, username, senha, role } = req.body;
        if (!nome || !username || !senha) return res.status(400).json({ error: 'Preencha nome, usuário e senha.' });
        const existe = await User.findOne({ where: { username } });
        if (existe) return res.status(409).json({ error: 'Esse usuário já existe.' });
        const hash = await bcrypt.hash(senha, 10);
        let roleFinal = role === 'operador' ? 'operador' : (role === 'dev' ? 'dev' : 'gestor');
        if (roleFinal === 'dev' && req.user.role !== 'dev') roleFinal = 'gestor';
        const novo = await User.create({
            nome, username, passwordHash: hash, role: roleFinal, status: 'aprovado'
        });
        res.json({ success: true, user: { id: novo.id, nome: novo.nome, username: novo.username, role: novo.role } });
    } catch (e) { res.status(500).json({ error: 'Erro ao criar usuário.' }); }
});

// Qualquer autenticado: trocar a própria senha
app.post('/auth/password', isAuth, async (req, res) => {
    try {
        const { senhaAtual, novaSenha } = req.body;
        if (!senhaAtual || !novaSenha) return res.status(400).json({ error: 'Informe senha atual e nova senha.' });
        const u = await User.findByPk(req.user.id);
        const ok = await bcrypt.compare(senhaAtual, u.passwordHash);
        if (!ok) return res.status(400).json({ error: 'Senha atual incorreta.' });
        u.passwordHash = await bcrypt.hash(novaSenha, 10);
        await u.save();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Erro ao alterar senha.' }); }
});

// Redefinir senha de qualquer usuário (Dev ou Operador). Operador não redefine de Dev.
app.post('/auth/reset/:id', isManager, async (req, res) => {
    try {
        const { novaSenha } = req.body;
        if (!novaSenha) return res.status(400).json({ error: 'Informe a nova senha.' });
        const u = await User.findByPk(req.params.id);
        if (!u) return res.status(404).json({ error: 'Usuário não encontrado.' });
        if (u.role === 'dev' && req.user.role !== 'dev') return res.status(403).json({ error: 'Operador não pode redefinir senha de Dev.' });
        u.passwordHash = await bcrypt.hash(novaSenha, 10);
        await u.save();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Erro ao resetar senha.' }); }
});

// Quantidade de cadastros pendentes (badge do painel Dev/Operador)
app.get('/auth/pending-count', isAuth, async (req, res) => {
    if (req.user.role !== 'dev' && req.user.role !== 'operador') return res.json({ count: 0 });
    let where = { status: 'pendente' };
    if (req.user.role !== 'dev') where.role = { [Op.ne]: 'dev' };
    const count = await User.count({ where });
    res.json({ count });
});

// ====================================================
//   ROTAS DE TICKETS
// ====================================================

// Abertura de chamado pelo usuário final (público)
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

// Resolução / escalonamento (staff: dev ou gestor)
app.post('/api/ticket/update', isStaff, async (req, res) => {
    const { id, status, solucao, analista } = req.body;
    const ticket = await Ticket.findByPk(id);
    if (ticket) {
        const dadosUpdate = { status, solucao, analista: analista || req.user.nome };
        if (status.includes('solucionado') || status === 'n3') {
            dadosUpdate.data_fechamento = new Date();
            dadosUpdate.tempo_resolucao = calcularTempo(ticket.timestamp, dadosUpdate.data_fechamento);
        }
        await ticket.update(dadosUpdate);
        io.emit('atualiza_chamado', { id, status });
        res.json({ success: true });
    } else { res.status(404).json({ error: 'Ticket não encontrado' }); }
});

// Autoatendimento via chatbot (público)
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

// Tickets ativos no painel do operador (staff)
app.get('/api/tickets/ativos', isStaff, async (req, res) => {
    const tickets = await Ticket.findAll({ where: { status: 'aberto' } });
    res.json(tickets);
});

// Estatísticas do dia (staff)
app.get('/api/stats/hoje', isStaff, async (req, res) => {
    try {
        const inicioDia = new Date(); inicioDia.setHours(0, 0, 0, 0);
        const tickets = await Ticket.findAll({ where: { timestamp: { [Op.gte]: inicioDia } }, order: [['timestamp', 'DESC']] });

        const listHumanos = tickets.filter(t => t.status === 'solucionado');
        const listRobo = tickets.filter(t => t.status === 'auto_solucionado');
        const listN3 = tickets.filter(t => t.status === 'n3');

        const categorias = {};
        tickets.forEach(t => {
            let cat = t.setor === 'Autoatendimento' ? 'Robô' : t.problema.split(']')[0].replace('[', '').trim();
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

// ====================================================
//   HISTÓRICO E ARQUIVOS (staff)
// ====================================================

app.get('/api/historico', isStaff, async (req, res) => {
    try {
        const { inicio, fim, status, busca } = req.query;
        const where = {};
        if (inicio && fim) {
            const dataFim = new Date(fim); dataFim.setHours(23, 59, 59, 999);
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

app.get('/api/exportar', isStaff, async (req, res) => {
    const { inicio, fim } = req.query;
    const tickets = await Ticket.findAll({
        where: { timestamp: { [Op.between]: [new Date(inicio), new Date(fim + 'T23:59:59')] } }
    });
    const csvWriter = createObjectCsvWriter({
        path: './temp_export.csv',
        header: [
            { id: 'id', title: 'ID' }, { id: 'timestamp', title: 'ABERTURA' },
            { id: 'solicitante', title: 'SOLICITANTE' }, { id: 'setor', title: 'SETOR' },
            { id: 'problema', title: 'PROBLEMA' }, { id: 'status', title: 'STATUS' }
        ]
    });
    await csvWriter.writeRecords(tickets.map(t => t.dataValues));
    res.download('./temp_export.csv', `Relatorio_Parcial_${inicio}.csv`);
});

app.get('/api/logs-list', isStaff, (req, res) => {
    const logRoot = path.join(__dirname, 'logs');
    if (!fs.existsSync(logRoot)) return res.json([]);

    const anos = fs.readdirSync(logRoot);
    let arquivos = [];

    anos.forEach(ano => {
        const pastaAno = path.join(logRoot, ano);
        if (fs.lstatSync(pastaAno).isDirectory()) {
            const files = fs.readdirSync(pastaAno).filter(f => f.endsWith('.csv'));
            files.forEach(f => { arquivos.push({ ano, arquivo: f }); });
        }
    });
    res.json(arquivos.reverse());
});

app.get('/api/logs/download/:ano/:arquivo', isStaff, (req, res) => {
    const { ano, arquivo } = req.params;
    const file = path.join(__dirname, 'logs', ano, arquivo);
    if (fs.existsSync(file)) res.download(file);
    else res.status(404).send('Arquivo não encontrado');
});

// ====================================================
//   ROTINA DE TURNO (07:00)
// ====================================================
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
                { id: 'id', title: 'ID' }, { id: 'timestamp', title: 'DATA_ABERTURA' },
                { id: 'data_fechamento', title: 'DATA_FECHAMENTO' }, { id: 'solicitante', title: 'SOLICITANTE' },
                { id: 'matricula', title: 'MATRICULA' }, { id: 'setor', title: 'SETOR' },
                { id: 'problema', title: 'OCORRENCIA' }, { id: 'prioridade', title: 'PRIORIDADE' },
                { id: 'status', title: 'STATUS' }, { id: 'analista', title: 'ANALISTA' },
                { id: 'tempo_resolucao', title: 'TEMPO_RESOLUCAO' }, { id: 'solucao', title: 'OBSERVACAO' }
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
