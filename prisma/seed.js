require('dotenv/config');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');

async function main() {
  const username = 'marcio';
  const password = '231989mtk';
  const hashedPassword = await bcrypt.hash(password, 10);

  await prisma.user.upsert({
    where: { username },
    update: {},
    create: { username, password: hashedPassword },
  });

  console.log(`Usuário "${username}" criado/garantido com sucesso.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
