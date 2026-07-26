const { Router } = require('express');
const authController = require('../controllers/authController');

const router = Router();

router.get('/', (req, res) => {
  res.json({ status: 'online', message: 'API está online.' });
});

router.post('/login', authController.login);
router.get('/me', authController.me);

module.exports = router;
