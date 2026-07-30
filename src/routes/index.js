const { Router, text } = require('express');
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

// Chamado pelo ESP32 periodicamente para sinalizar que está online.
// Resposta em texto puro inclui "atualizadoEm", usado pelo ESP32 para
// saber se a config dele está desatualizada em relação à API.
router.post('/tanques/:codigo/ping', tanqueController.ping);

// Sincronização direta ESP32 <-> API (fora do BLE), para quando o
// dispositivo fica sem internet no momento de uma mudança:
// - POST: o ESP32 empurra uma config alterada localmente e pendente.
// - GET: o ESP32 puxa a config atual quando percebe (via ping) que a
//   API tem uma versão mais nova do que a que ele conhece.
router.post(
  '/tanques/:codigo/sincronizar',
  text({ type: '*/*' }),
  tanqueController.sincronizarDoDispositivo,
);
router.get('/tanques/:codigo/config', tanqueController.obterConfigDispositivo);

// Consumidos pelo app (seção "Meus Tanques").
// TODO: proteger com authMiddleware quando o login do app estiver
// integrado de fato com a API (hoje login_screen.dart é só UI).
router.get('/tanques', tanqueController.listar);
router.get('/tanques/:codigo', tanqueController.detalhar);
router.patch('/tanques/:codigo', tanqueController.atualizar);
router.delete('/tanques/:codigo', tanqueController.remover);

router.get('/tanques/:codigo/horarios', tanqueController.listarHorarios);
router.post('/tanques/:codigo/horarios', tanqueController.criarHorario);
router.patch('/tanques/:codigo/horarios/:id', tanqueController.atualizarHorario);
router.delete('/tanques/:codigo/horarios/:id', tanqueController.removerHorario);

module.exports = router;
