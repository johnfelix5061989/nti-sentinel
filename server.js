require('dotenv').config();
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
const rateLimit = require('express-rate-limit');
const { Op } = require('sequelize');

// --- Configuração ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Confia no proxy reverso (Nginx/Caddy) em produção
app.set('trust proxy', 1);

app.use(express.static('public'));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// --- Sessão ---
const isProd = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 1000 * 60 * 60 * 8, // 8 horas
        secure: isProd,             // HTTPS em produção
        sameSite: 'lax',            // proteção CSRF
        httpOnly: true              // JS não acessa o cookie
    }
}));

// --- Banco de Dados ---
const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: process.env.DB_PATH || './database.sqlite',
    logging: false
});

const Ticket = sequelize.define('Ticket', {
    solicitante: Sequelize.STRING,
    matricula: Sequelize.STRING,
    setor: Sequelize.STRING,
    ramal: Sequelize.STRING,
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
function isManager(req, res, next) {
    if (req.isAuthenticated() && (req.user.role === 'dev' || req.user.role === 'operador')) return next();
    return res.status(403).json({ error: 'Acesso restrito a quem gerencia usuários.' });
}
function isStaff(req, res, next) {
    if (req.isAuthenticated() && (req.user.role === 'dev' || req.user.role === 'gestor' || req.user.role === 'operador')) return next();
    return res.status(403).json({ error: 'Acesso restrito a usuários autorizados.' });
}

// --- Rate Limiters ---
const loginLimiter = rateLimit({
    windowMs: 60 * 1000, max: 5,
    message: { error: 'Muitas tentativas. Aguarde 1 minuto.' },
    standardHeaders: true, legacyHeaders: false
});
const ticketLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, max: 10,
    message: { error: 'Limite de chamados por hora atingido. Tente mais tarde.' },
    standardHeaders: true, legacyHeaders: false
});
const registroLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, max: 5,
    message: { error: 'Muitos cadastros. Aguarde uma hora.' },
    standardHeaders: true, legacyHeaders: false
});

// --- Validações ---
function validarSenhaForte(senha) {
    if (!senha || senha.length < 6) return 'A senha deve ter no mínimo 6 caracteres.';
    if (!/[A-Za-z]/.test(senha) || !/[0-9]/.test(senha)) return 'A senha deve conter letras e números.';
    return null;
}
function sanitizar(s, max = 255) {
    if (typeof s !== 'string') return '';
    return s.slice(0, max);
}

// --- Seed do Dev inicial ---
async function seedDev() {
    const count = await User.count();
    if (count === 0) {
        const senhaInicial = process.env.ADMIN_SENHA || 'nti2026';
        const hash = await bcrypt.hash(senhaInicial, 10);
        await User.create({
            nome: 'Administrador NTI', username: process.env.ADMIN_USER || 'admin',
            passwordHash: hash, role: 'dev', status: 'aprovado'
        });
        console.log(`🔐 Dev inicial criado -> usuario: ${process.env.ADMIN_USER || 'admin'} | Altere a senha após o primeiro login.`);
    }
}

sequelize.sync().then(async () => {
    console.log("💾 Banco de dados pronto e sincronizado.");
    const [cols] = await sequelize.query('PRAGMA table_info(Tickets)');
    const nomes = cols.map(c => c.name);
    if (!nomes.includes('ramal')) {
        await sequelize.query("ALTER TABLE Tickets ADD COLUMN ramal VARCHAR(255)");
        console.log("➕ Coluna 'ramal' adicionada à tabela Tickets.");
    }
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

app.post('/auth/register', registroLimiter, async (req, res) => {
    try {
        const nome = sanitizar(req.body.nome, 100);
        const username = sanitizar(req.body.username, 50).toLowerCase();
        const senha = req.body.senha;
        const role = req.body.role;
        if (!nome || !username || !senha) return res.status(400).json({ error: 'Preencha nome, usuário e senha.' });
        const erroSenha = validarSenhaForte(senha);
        if (erroSenha) return res.status(400).json({ error: erroSenha });
        const existe = await User.findOne({ where: { username } });
        if (existe) return res.status(409).json({ error: 'Esse usuário já existe.' });
        const hash = await bcrypt.hash(senha, 10);
        const roleFinal = role === 'operador' ? 'operador' : 'gestor';
        await User.create({ nome, username, passwordHash: hash, role: roleFinal, status: 'pendente' });
        console.log(`📋 Novo cadastro pendente: ${username} (${roleFinal})`);
        res.json({ success: true, message: 'Cadastro realizado! Aguarde a aprovação para acessar.' });
    } catch (e) { console.error('Erro /auth/register:', e); res.status(500).json({ error: 'Erro ao cadastrar.' }); }
});

app.post('/auth/login', loginLimiter, (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
        if (err) { console.error('Erro login:', err); return next(err); }
        if (!user) return res.status(401).json({ error: info.message || 'Credenciais inválidas.' });
        req.login(user, (err) => {
            if (err) return next(err);
            console.log(`🔑 Login: ${user.username} (${user.role})`);
            res.json({
                success: true,
                user: { id: user.id, nome: user.nome, username: user.username, role: user.role, status: user.status }
            });
        });
    })(req, res, next);
});

app.post('/auth/logout', (req, res) => {
    const u = req.user ? req.user.username : '?';
    req.logout(() => {
        console.log(`👋 Logout: ${u}`);
        res.json({ success: true });
    });
});

app.get('/auth/me', (req, res) => {
    if (req.isAuthenticated()) return res.json({ authenticated: true, user: req.user });
    res.json({ authenticated: false });
});

app.get('/auth/users', isManager, async (req, res) => {
    try {
        let where = {};
        if (req.user.role !== 'dev') where.role = { [Op.ne]: 'dev' };
        const users = await User.findAll({ where, order: [['status', 'ASC'], ['criadoEm', 'DESC']] });
        res.json(users.map(u => ({
            id: u.id, nome: u.nome, username: u.username,
            role: u.role, status: u.status, criadoEm: u.criadoEm
        })));
    } catch (e) { console.error('Erro /auth/users:', e); res.status(500).json({ error: 'Erro ao listar.' }); }
});

app.post('/auth/approve/:id', isManager, async (req, res) => {
    try {
        const u = await User.findByPk(req.params.id);
        if (!u) return res.status(404).json({ error: 'Usuário não encontrado.' });
        if (u.role === 'dev' && req.user.role !== 'dev') return res.status(403).json({ error: 'Operador não pode aprovar Dev.' });
        await u.update({ status: 'aprovado' });
        console.log(`✅ Aprovado: ${u.username} por ${req.user.username}`);
        res.json({ success: true });
    } catch (e) { console.error('Erro approve:', e); res.status(500).json({ error: 'Erro ao aprovar.' }); }
});

app.post('/auth/reject/:id', isManager, async (req, res) => {
    try {
        const u = await User.findByPk(req.params.id);
        if (!u) return res.status(404).json({ error: 'Usuário não encontrado.' });
        if (u.username === 'admin') return res.status(400).json({ error: 'O admin inicial não pode ser removido.' });
        if (u.role === 'dev' && req.user.role !== 'dev') return res.status(403).json({ error: 'Operador não pode remover Dev.' });
        await u.destroy();
        console.log(`❌ Removido: ${u.username} por ${req.user.username}`);
        res.json({ success: true });
    } catch (e) { console.error('Erro reject:', e); res.status(500).json({ error: 'Erro ao remover.' }); }
});

app.post('/auth/create', isManager, async (req, res) => {
    try {
        const nome = sanitizar(req.body.nome, 100);
        const username = sanitizar(req.body.username, 50).toLowerCase();
        const senha = req.body.senha;
        const role = req.body.role;
        if (!nome || !username || !senha) return res.status(400).json({ error: 'Preencha nome, usuário e senha.' });
        const erroSenha = validarSenhaForte(senha);
        if (erroSenha) return res.status(400).json({ error: erroSenha });
        const existe = await User.findOne({ where: { username } });
        if (existe) return res.status(409).json({ error: 'Esse usuário já existe.' });
        const hash = await bcrypt.hash(senha, 10);
        let roleFinal = role === 'operador' ? 'operador' : (role === 'dev' ? 'dev' : 'gestor');
        if (roleFinal === 'dev' && req.user.role !== 'dev') roleFinal = 'gestor';
        const novo = await User.create({ nome, username, passwordHash: hash, role: roleFinal, status: 'aprovado' });
        console.log(`➕ Criado: ${novo.username} (${roleFinal}) por ${req.user.username}`);
        res.json({ success: true, user: { id: novo.id, nome: novo.nome, username: novo.username, role: novo.role } });
    } catch (e) { console.error('Erro create:', e); res.status(500).json({ error: 'Erro ao criar usuário.' }); }
});

app.post('/auth/password', isAuth, async (req, res) => {
    try {
        const { senhaAtual, novaSenha } = req.body;
        if (!senhaAtual || !novaSenha) return res.status(400).json({ error: 'Informe senha atual e nova senha.' });
        const erroSenha = validarSenhaForte(novaSenha);
        if (erroSenha) return res.status(400).json({ error: erroSenha });
        const u = await User.findByPk(req.user.id);
        const ok = await bcrypt.compare(senhaAtual, u.passwordHash);
        if (!ok) return res.status(400).json({ error: 'Senha atual incorreta.' });
        u.passwordHash = await bcrypt.hash(novaSenha, 10);
        await u.save();
        console.log(`🔑 Senha alterada por: ${req.user.username}`);
        res.json({ success: true });
    } catch (e) { console.error('Erro password:', e); res.status(500).json({ error: 'Erro ao alterar senha.' }); }
});

app.post('/auth/reset/:id', isManager, async (req, res) => {
    try {
        const { novaSenha } = req.body;
        if (!novaSenha) return res.status(400).json({ error: 'Informe a nova senha.' });
        const erroSenha = validarSenhaForte(novaSenha);
        if (erroSenha) return res.status(400).json({ error: erroSenha });
        const u = await User.findByPk(req.params.id);
        if (!u) return res.status(404).json({ error: 'Usuário não encontrado.' });
        if (u.role === 'dev' && req.user.role !== 'dev') return res.status(403).json({ error: 'Operador não pode redefinir senha de Dev.' });
        u.passwordHash = await bcrypt.hash(novaSenha, 10);
        await u.save();
        console.log(`🔐 Senha redefinida de ${u.username} por ${req.user.username}`);
        res.json({ success: true });
    } catch (e) { console.error('Erro reset:', e); res.status(500).json({ error: 'Erro ao resetar senha.' }); }
});

app.get('/auth/pending-count', isAuth, async (req, res) => {
    try {
        if (req.user.role !== 'dev' && req.user.role !== 'operador') return res.json({ count: 0 });
        let where = { status: 'pendente' };
        if (req.user.role !== 'dev') where.role = { [Op.ne]: 'dev' };
        const count = await User.count({ where });
        res.json({ count });
    } catch (e) { console.error('Erro pending-count:', e); res.json({ count: 0 }); }
});

// ====================================================
//   ROTAS DE TICKETS
// ====================================================

app.post('/api/ticket', ticketLimiter, async (req, res) => {
    try {
        const solicitante = sanitizar(req.body.solicitante, 100);
        const matricula = sanitizar(req.body.matricula, 50);
        const setor = sanitizar(req.body.setor, 100);
        const problema = sanitizar(req.body.problema, 500);
        const ramal = sanitizar(req.body.ramal, 100);
        if (!solicitante || !setor || !problema) return res.status(400).json({ error: 'Solicitante, setor e problema são obrigatórios.' });
        const setoresCriticos = ["CICCE/OPERAÇÕES", "SALA DE CRISES", "CALL CENTER", "DESPACHO"];
        let prioridade = setoresCriticos.includes(setor.toUpperCase()) ? 'Alta' : 'Normal';
        const novoTicket = await Ticket.create({ solicitante, matricula, setor, ramal, problema, prioridade });
        io.emit('novo_chamado', novoTicket);
        console.log(`📝 Novo chamado #${novoTicket.id}: ${solicitante} | ${setor} | ${prioridade}`);
        res.json({ success: true, ticket: novoTicket });
    } catch (e) { console.error('Erro /api/ticket:', e); res.status(500).json({ error: 'Erro ao criar ticket' }); }
});

app.post('/api/ticket/update', isStaff, async (req, res) => {
    try {
        const { id, status } = req.body;
        const solucao = sanitizar(req.body.solucao, 1000);
        if (!id || !status || !solucao) return res.status(400).json({ error: 'ID, status e solução são obrigatórios.' });
        const ticket = await Ticket.findByPk(id);
        if (!ticket) return res.status(404).json({ error: 'Ticket não encontrado' });
        const dadosUpdate = { status, solucao, analista: req.user.nome };
        if (status.includes('solucionado') || status === 'n3') {
            dadosUpdate.data_fechamento = new Date();
            dadosUpdate.tempo_resolucao = calcularTempo(ticket.timestamp, dadosUpdate.data_fechamento);
        }
        await ticket.update(dadosUpdate);
        io.emit('atualiza_chamado', { id, status });
        console.log(`✏️ Ticket #${id} -> ${status} por ${req.user.username}`);
        res.json({ success: true });
    } catch (e) { console.error('Erro ticket/update:', e); res.status(500).json({ error: 'Erro ao atualizar' }); }
});

app.post('/api/ticket/auto', ticketLimiter, async (req, res) => {
    try {
        const solicitante = sanitizar(req.body.solicitante, 100) || "Usuário Web";
        const problema = sanitizar(req.body.problema, 500);
        if (!problema) return res.status(400).json({ error: 'Problema é obrigatório.' });
        await Ticket.create({
            solicitante, matricula: "CHATBOT", setor: "Autoatendimento", problema,
            status: 'auto_solucionado', solucao: 'Resolvido via Chatbot',
            analista: 'Sistema (Bot)', data_fechamento: new Date(), tempo_resolucao: '0h 0m'
        });
        res.json({ success: true });
    } catch (e) { console.error('Erro ticket/auto:', e); res.status(500).json({ error: 'Erro' }); }
});

app.get('/api/tickets/ativos', isStaff, async (req, res) => {
    try {
        const tickets = await Ticket.findAll({ where: { status: 'aberto' } });
        res.json(tickets);
    } catch (e) { console.error('Erro ativos:', e); res.status(500).json([]); }
});

app.get('/api/stats/hoje', isStaff, async (req, res) => {
    try {
        const hojeStr = new Date().toISOString().split('T')[0];
        const inicioDia = new Date(hojeStr + 'T00:00:00');
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
            total: tickets.length, resolvidos_humanos: listHumanos.length,
            resolvidos_robo: listRobo.length, escalados_n3: listN3.length,
            grafico: categorias, detalhes: { total: tickets, humanos: listHumanos, robo: listRobo, n3: listN3 }
        });
    } catch (e) { console.error('Erro stats:', e); res.status(500).json({ error: "Erro stats" }); }
});

// ====================================================
//   HISTÓRICO (staff)
// ====================================================

app.get('/api/historico', isStaff, async (req, res) => {
    try {
        const { inicio, fim, status, busca } = req.query;
        const where = {};
        if (inicio && fim) {
            const dataFim = new Date(fim + 'T23:59:59.999');
            where.timestamp = { [Op.between]: [new Date(inicio + 'T00:00:00'), dataFim] };
        }
        if (status && status !== 'todos') where.status = status;
        if (busca) {
            const b = sanitizar(busca, 100);
            where[Op.or] = [
                { solicitante: { [Op.like]: `%${b}%` } },
                { matricula: { [Op.like]: `%${b}%` } },
                { problema: { [Op.like]: `%${b}%` } }
            ];
        }
        const tickets = await Ticket.findAll({ where, order: [['timestamp', 'DESC']] });
        res.json(tickets);
    } catch (e) { console.error('Erro historico:', e); res.status(500).json([]); }
});

// ====================================================
//   ROTINA DE TURNO (07:00) — append para não sobrescrever
// ====================================================
cron.schedule('0 7 * * *', async () => {
    try {
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
                path: filePath, append: fs.existsSync(filePath),
                header: [
                    { id: 'id', title: 'ID' }, { id: 'timestamp', title: 'DATA_ABERTURA' },
                    { id: 'data_fechamento', title: 'DATA_FECHAMENTO' }, { id: 'solicitante', title: 'SOLICITANTE' },
                    { id: 'matricula', title: 'MATRICULA' }, { id: 'setor', title: 'SETOR' },
                    { id: 'ramal', title: 'RAMAL_LOCAL' },
                    { id: 'problema', title: 'OCORRENCIA' }, { id: 'prioridade', title: 'PRIORIDADE' },
                    { id: 'status', title: 'STATUS' }, { id: 'analista', title: 'ANALISTA' },
                    { id: 'tempo_resolucao', title: 'TEMPO_RESOLUCAO' }, { id: 'solucao', title: 'OBSERVACAO' }
                ]
            });
            await csvWriter.writeRecords(ticketsParaArquivar.map(t => t.dataValues));
            await Ticket.destroy({ where: { status: { [Op.or]: ['solucionado', 'auto_solucionado'] } } });
            console.log(`✅ ${ticketsParaArquivar.length} tickets arquivados em ${filePath}.`);
            io.emit('refresh_dashboard');
        }
    } catch (e) { console.error('Erro no cron de arquivamento:', e); }
});

// ====================================================
//   INIT
// ====================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🔥 Sentinel rodando na porta ${PORT} (${isProd ? 'produção' : 'desenvolvimento'})`));

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM recebido. Encerrando...');
    server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
    console.log('SIGINT recebido. Encerrando...');
    server.close(() => process.exit(0));
});
