const { Router } = require('express');
const authController = require('../controllers/authController');
const authMiddleware = require('../middlewares/auth');

const router = Router();

router.get('/', (req, res) => {
  res.json({ status: 'online', message: 'API está online.' });
});

router.post('/login', authController.login);
router.get('/me', authMiddleware, authController.me);

module.exports = router;
