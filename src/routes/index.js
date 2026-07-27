const { Router } = require('express');
const authController = require('../controllers/authController');
const tanqueController = require('../controllers/tanqueController');

const router = Router();

router.get('/', (req, res) => {
  res.json({ status: 'online', message: 'API está online.' });
});

router.post('/login', authController.login);
router.get('/me', authController.me);

// Chamado pelo app ao final da configuração do dispositivo.
router.post('/tanques', tanqueController.registrar);

// Chamado pelo ESP32 a cada 5s para sinalizar que está online.
router.post('/tanques/:codigo/ping', tanqueController.ping);

// Consumidos pelo app (seção "Meus Tanques").
// TODO: proteger com authMiddleware quando o login do app estiver
// integrado de fato com a API (hoje login_screen.dart é só UI).
router.get('/tanques', tanqueController.listar);
router.get('/tanques/:codigo', tanqueController.detalhar);
router.patch('/tanques/:codigo', tanqueController.atualizar);

router.get('/tanques/:codigo/horarios', tanqueController.listarHorarios);
router.post('/tanques/:codigo/horarios', tanqueController.criarHorario);
router.patch('/tanques/:codigo/horarios/:id', tanqueController.atualizarHorario);
router.delete('/tanques/:codigo/horarios/:id', tanqueController.removerHorario);

module.exports = router;
