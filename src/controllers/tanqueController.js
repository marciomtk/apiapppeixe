const prisma = require('../lib/prisma');

// 3x o intervalo de ping do ESP32 (1 min), para tolerar um ping perdido
// antes de considerar o alimentador offline.
const PING_TIMEOUT_MS = 180000;

function minutosDoDia(hora) {
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

function calcularProximaAlimentacao(horarios) {
  const lista = horarios || [];
  if (lista.length === 0) return null;

  const agora = new Date();
  const minutosAgora = agora.getHours() * 60 + agora.getMinutes();

  const ordenados = [...lista].sort(
    (a, b) => minutosDoDia(a.hora) - minutosDoDia(b.hora),
  );

  const proximaHoje = ordenados.find((h) => minutosDoDia(h.hora) > minutosAgora);

  // Se não sobrou nenhum horário hoje, a próxima é a mais cedo (amanhã).
  const alvo = proximaHoje ?? ordenados[0];
  return { hora: alvo.hora, peso: alvo.peso };
}

function calcularUltimoTrato(horarios) {
  const lista = horarios || [];
  if (lista.length === 0) return null;

  const agora = new Date();
  const minutosAgora = agora.getHours() * 60 + agora.getMinutes();

  const ordenados = [...lista].sort(
    (a, b) => minutosDoDia(a.hora) - minutosDoDia(b.hora),
  );

  const jaPassaramHoje = ordenados.filter((h) => minutosDoDia(h.hora) <= minutosAgora);

  // Se já passou algum horário hoje, o último trato é o mais recente deles.
  // Senão, foi o mais tardio de ontem (o último da lista, ciclo diário).
  const alvo =
    jaPassaramHoje.length > 0
      ? jaPassaramHoje[jaPassaramHoje.length - 1]
      : ordenados[ordenados.length - 1];

  return { hora: alvo.hora, peso: alvo.peso };
}

// Projeta a quantidade de ração restante no silo com base no tempo
// desde o último abastecimento e no consumo diário (soma dos pesos dos
// horários cadastrados) — sem depender de telemetria do ESP32.
function calcularSilo(tanque) {
  const capacidadeKg = tanque.quantidadeSiloKg ?? 0;
  const abastecidoEm = tanque.siloAbastecidoEm;

  const consumoDiarioGramas = (tanque.horarios || []).reduce(
    (soma, h) => soma + h.peso,
    0,
  );

  if (capacidadeKg <= 0) {
    return {
      quantidadeAtualKg: 0,
      capacidadeKg: 0,
      percentual: 0,
      diasRestantes: null,
      consumoDiarioGramas,
    };
  }

  const diasPassados = abastecidoEm
    ? (Date.now() - abastecidoEm.getTime()) / 86400000
    : 0;

  const consumidoKg = (diasPassados * consumoDiarioGramas) / 1000;
  const atualKg = Math.max(0, capacidadeKg - consumidoKg);
  const percentual = Math.round((atualKg / capacidadeKg) * 100);
  const diasRestantes =
    consumoDiarioGramas > 0 ? Math.floor(atualKg / (consumoDiarioGramas / 1000)) : null;

  return {
    quantidadeAtualKg: Math.round(atualKg * 10) / 10,
    capacidadeKg,
    percentual,
    diasRestantes,
    consumoDiarioGramas,
  };
}

function serializarTanque(tanque) {
  const online =
    !!tanque.ultimoPingEm &&
    Date.now() - tanque.ultimoPingEm.getTime() < PING_TIMEOUT_MS;

  return {
    codigo: tanque.codigo,
    nome: tanque.nome,
    especie: tanque.especie,
    quantidade: tanque.quantidade,
    pesoMedio: tanque.pesoMedio,
    online,
    ultimoPingEm: tanque.ultimoPingEm,
    proximaAlimentacao: calcularProximaAlimentacao(tanque.horarios)?.hora ?? null,
    ultimoTrato: calcularUltimoTrato(tanque.horarios),
    silo: calcularSilo(tanque),
  };
}

function serializarHorario(horario) {
  return {
    id: horario.id,
    hora: horario.hora,
    peso: horario.peso,
  };
}

// =============================
// Protocolo "chave=valor|chave=valor" com o ESP32
// =============================
// Mesmo formato usado no BLE (onRead/onWrite do firmware), reaproveitado
// aqui para a sincronização direta com a API — assim o ESP32 usa as
// mesmas funções de parsing (extrairCampo/aplicarHorariosString) tanto
// para BLE quanto para HTTP, sem precisar de uma lib de JSON.

function horariosParaPipe(horarios) {
  return (horarios || [])
    .map((h) => `${h.hora}-${Math.round(h.peso)}`)
    .join(';');
}

function parsePipeConfig(texto) {
  const campos = {};

  String(texto || '')
    .split('|')
    .forEach((segmento) => {
      const idx = segmento.indexOf('=');
      if (idx === -1) return;
      campos[segmento.slice(0, idx)] = segmento.slice(idx + 1);
    });

  return campos;
}

function parseHorariosPipe(texto) {
  if (!texto) return [];

  return String(texto)
    .split(';')
    .map((item) => {
      const [hora, peso] = item.split('-');
      return { hora, peso: Number(peso) };
    })
    .filter((h) => /^\d{2}:\d{2}$/.test(h.hora || '') && Number.isFinite(h.peso));
}

function serializarConfigPipe(tanque) {
  return [
    `nome=${tanque.nome}`,
    `especie=${tanque.especie}`,
    `qtd=${tanque.quantidade}`,
    `peso=${tanque.pesoMedio}`,
    `horarios=${horariosParaPipe(tanque.horarios)}`,
    `atualizadoEm=${tanque.atualizadoEm.getTime()}`,
  ].join('|');
}

// Valida o Bearer token do ESP32 contra o token salvo para o tanque.
// Retorna o tanque (sem horarios) se válido, ou envia a resposta de erro
// e retorna null.
async function autenticarDispositivo(req, res) {
  const { codigo } = req.params;
  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    res.status(401).type('text/plain').send('ERRO:token_ausente');
    return null;
  }

  const tanque = await prisma.tanque.findUnique({ where: { codigo } });

  if (!tanque || tanque.token !== token) {
    res.status(401).type('text/plain').send('ERRO:token_invalido');
    return null;
  }

  return tanque;
}

async function registrar(req, res) {
  const { codigo, nome, especie, quantidade, pesoMedio, token } = req.body;

  if (!codigo || !nome || !especie || !token) {
    return res
      .status(400)
      .json({ error: 'codigo, nome, especie e token são obrigatórios.' });
  }

  const quantidadeNum = Number(quantidade);
  const pesoMedioNum = Number(pesoMedio);

  if (!Number.isFinite(quantidadeNum) || !Number.isFinite(pesoMedioNum)) {
    return res
      .status(400)
      .json({ error: 'quantidade e pesoMedio devem ser numéricos.' });
  }

  const tanque = await prisma.tanque.upsert({
    where: { codigo },
    update: {
      nome,
      especie,
      quantidade: quantidadeNum,
      pesoMedio: pesoMedioNum,
      token,
    },
    create: {
      codigo,
      nome,
      especie,
      quantidade: quantidadeNum,
      pesoMedio: pesoMedioNum,
      token,
    },
    include: { horarios: true },
  });

  return res.status(201).json(serializarTanque(tanque));
}

// Atualiza os dados exibidos/editáveis do tanque (não mexe no token,
// que só é definido/trocado refazendo a configuração pelo app+BLE).
async function atualizar(req, res) {
  const { codigo } = req.params;
  const { nome, especie, quantidade, pesoMedio, quantidadeSiloKg } = req.body;

  const data = {};

  if (nome !== undefined) data.nome = nome;
  if (especie !== undefined) data.especie = especie;

  if (quantidade !== undefined) {
    const quantidadeNum = Number(quantidade);
    if (!Number.isFinite(quantidadeNum)) {
      return res.status(400).json({ error: '"quantidade" deve ser numérica.' });
    }
    data.quantidade = quantidadeNum;
  }

  if (pesoMedio !== undefined) {
    const pesoMedioNum = Number(pesoMedio);
    if (!Number.isFinite(pesoMedioNum)) {
      return res.status(400).json({ error: '"pesoMedio" deve ser numérico.' });
    }
    data.pesoMedio = pesoMedioNum;
  }

  if (quantidadeSiloKg !== undefined) {
    const siloNum = Number(quantidadeSiloKg);
    if (!Number.isFinite(siloNum) || siloNum < 0) {
      return res
        .status(400)
        .json({ error: '"quantidadeSiloKg" deve ser numérico e não-negativo.' });
    }
    // Editar esse campo representa um (re)abastecimento: reinicia a
    // contagem de dias usada para projetar o consumo.
    data.quantidadeSiloKg = siloNum;
    data.siloAbastecidoEm = new Date();
  }

  const tanqueExistente = await prisma.tanque.findUnique({ where: { codigo } });

  if (!tanqueExistente) {
    return res.status(404).json({ error: 'Tanque não encontrado.' });
  }

  const tanque = await prisma.tanque.update({
    where: { codigo },
    data,
    include: { horarios: true },
  });

  return res.json(serializarTanque(tanque));
}

// Exclui o tanque (e seus horários, em cascata) permanentemente.
async function remover(req, res) {
  const { codigo } = req.params;

  const tanqueExistente = await prisma.tanque.findUnique({ where: { codigo } });

  if (!tanqueExistente) {
    return res.status(404).json({ error: 'Tanque não encontrado.' });
  }

  await prisma.tanque.delete({ where: { codigo } });

  return res.status(204).send();
}

// Resposta em texto puro (não JSON) porque quem chama é o ESP32, que já
// tem um parser "chave=valor" pronto do protocolo BLE — evita depender
// de uma lib de JSON no firmware. O "atualizadoEm" deixa o ESP32 saber,
// a cada ping, se a config dele está desatualizada em relação à API.
async function ping(req, res) {
  const { codigo } = req.params;

  const tanque = await autenticarDispositivo(req, res);
  if (!tanque) return;

  const atualizado = await prisma.tanque.update({
    where: { codigo },
    data: { ultimoPingEm: new Date() },
  });

  return res
    .type('text/plain')
    .send(`status=online|atualizadoEm=${atualizado.atualizadoEm.getTime()}`);
}

// Chamado pelo ESP32 quando detecta que fez uma alteração local (via
// BLE) enquanto estava sem internet: assim que a conexão volta, ele
// empurra a config pendente para a API em vez de esperar o app fazer
// isso (o app pode nunca mais passar perto daquele tanque).
// Corpo: texto puro no mesmo formato do onRead do BLE
// ("nome=..|especie=..|qtd=..|peso=..|horarios=..").
async function sincronizarDoDispositivo(req, res) {
  const { codigo } = req.params;

  const tanque = await autenticarDispositivo(req, res);
  if (!tanque) return;

  const campos = parsePipeConfig(req.body);

  const data = {};

  if (campos.nome !== undefined) data.nome = campos.nome;
  if (campos.especie !== undefined) data.especie = campos.especie;

  if (campos.qtd !== undefined) {
    const qtdNum = Number(campos.qtd);
    if (Number.isFinite(qtdNum)) data.quantidade = qtdNum;
  }

  if (campos.peso !== undefined) {
    const pesoNum = Number(campos.peso);
    if (Number.isFinite(pesoNum)) data.pesoMedio = pesoNum;
  }

  const horarios =
    campos.horarios !== undefined ? parseHorariosPipe(campos.horarios) : null;

  const atualizado = await prisma.$transaction(async (tx) => {
    if (Object.keys(data).length > 0) {
      await tx.tanque.update({ where: { codigo }, data });
    }

    if (horarios !== null) {
      await tx.horario.deleteMany({ where: { tanqueCodigo: codigo } });

      if (horarios.length > 0) {
        await tx.horario.createMany({
          data: horarios.map((h) => ({ tanqueCodigo: codigo, hora: h.hora, peso: h.peso })),
        });
      }
    }

    return tx.tanque.findUnique({ where: { codigo }, include: { horarios: true } });
  });

  return res.type('text/plain').send(serializarConfigPipe(atualizado));
}

// Chamado pelo ESP32 quando o ping acusa uma versão (atualizadoEm) mais
// nova do que a que ele conhece — provavelmente porque a config foi
// editada pelo app diretamente na API, sem passar pelo BLE. Devolve o
// snapshot atual no mesmo formato pipe, para o ESP32 aplicar localmente.
async function obterConfigDispositivo(req, res) {
  const { codigo } = req.params;

  const tanque = await autenticarDispositivo(req, res);
  if (!tanque) return;

  const completo = await prisma.tanque.findUnique({
    where: { codigo },
    include: { horarios: true },
  });

  return res.type('text/plain').send(serializarConfigPipe(completo));
}

// Lista os dispositivos (tanques) já configurados, para a seção
// "Meus Tanques" do app.
async function listar(req, res) {
  const tanques = await prisma.tanque.findMany({
    orderBy: { criadoEm: 'desc' },
    include: { horarios: true },
  });

  return res.json(tanques.map(serializarTanque));
}

async function detalhar(req, res) {
  const { codigo } = req.params;
  const tanque = await prisma.tanque.findUnique({
    where: { codigo },
    include: { horarios: true },
  });

  if (!tanque) {
    return res.status(404).json({ error: 'Tanque não encontrado.' });
  }

  return res.json(serializarTanque(tanque));
}

async function listarHorarios(req, res) {
  const { codigo } = req.params;

  const tanque = await prisma.tanque.findUnique({ where: { codigo } });

  if (!tanque) {
    return res.status(404).json({ error: 'Tanque não encontrado.' });
  }

  const horarios = await prisma.horario.findMany({
    where: { tanqueCodigo: codigo },
    orderBy: { hora: 'asc' },
  });

  return res.json(horarios.map(serializarHorario));
}

// Cria um novo horário de alimentação para o tanque.
// Corpo esperado: {"hora":"08:00","peso":300}
async function criarHorario(req, res) {
  const { codigo } = req.params;
  const { hora, peso } = req.body;

  if (typeof hora !== 'string' || !/^\d{2}:\d{2}$/.test(hora)) {
    return res.status(400).json({ error: '"hora" deve estar no formato HH:mm.' });
  }

  const pesoNum = Number(peso);
  if (!Number.isFinite(pesoNum)) {
    return res.status(400).json({ error: '"peso" deve ser numérico.' });
  }

  const tanque = await prisma.tanque.findUnique({ where: { codigo } });

  if (!tanque) {
    return res.status(404).json({ error: 'Tanque não encontrado.' });
  }

  const horario = await prisma.horario.create({
    data: { tanqueCodigo: codigo, hora, peso: pesoNum },
  });

  return res.status(201).json(serializarHorario(horario));
}

// Atualiza um horário existente (mudar hora e/ou peso).
async function atualizarHorario(req, res) {
  const { codigo, id } = req.params;
  const { hora, peso } = req.body;

  const data = {};

  if (hora !== undefined) {
    if (typeof hora !== 'string' || !/^\d{2}:\d{2}$/.test(hora)) {
      return res.status(400).json({ error: '"hora" deve estar no formato HH:mm.' });
    }
    data.hora = hora;
  }

  if (peso !== undefined) {
    const pesoNum = Number(peso);
    if (!Number.isFinite(pesoNum)) {
      return res.status(400).json({ error: '"peso" deve ser numérico.' });
    }
    data.peso = pesoNum;
  }

  const horarioExistente = await prisma.horario.findUnique({
    where: { id: Number(id) },
  });

  if (!horarioExistente || horarioExistente.tanqueCodigo !== codigo) {
    return res.status(404).json({ error: 'Horário não encontrado.' });
  }

  const horario = await prisma.horario.update({
    where: { id: Number(id) },
    data,
  });

  return res.json(serializarHorario(horario));
}

async function removerHorario(req, res) {
  const { codigo, id } = req.params;

  const horarioExistente = await prisma.horario.findUnique({
    where: { id: Number(id) },
  });

  if (!horarioExistente || horarioExistente.tanqueCodigo !== codigo) {
    return res.status(404).json({ error: 'Horário não encontrado.' });
  }

  await prisma.horario.delete({ where: { id: Number(id) } });

  return res.status(204).send();
}

module.exports = {
  registrar,
  atualizar,
  remover,
  ping,
  sincronizarDoDispositivo,
  obterConfigDispositivo,
  listar,
  detalhar,
  listarHorarios,
  criarHorario,
  atualizarHorario,
  removerHorario,
};
