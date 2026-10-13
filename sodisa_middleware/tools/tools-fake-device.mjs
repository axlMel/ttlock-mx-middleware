// tools/fake-device.mjs
// Simulador de equipos GPS para pruebas LOCALES. No forma parte del
// middleware (el middleware nunca abre sockets de escucha UDP).
// Uso: node tools/fake-device.mjs
import dgram from 'node:dgram';

const DEVICES = [
  { port: 55010, model: 'GV300W', imei: '863457050476769', header: '270D04' },
  { port: 55077, model: 'GV310LAU', imei: '868589060960328', header: '6E0A03' },
];

// Tramas reales capturadas en campo (las mismas del seed local).
const SAMPLES = {
  GV300W: {
    enter:
      '+RESP:GTGEO,270D04,863457050476769,,,01,1,1,0.0,0,2257.0,-99.127905,19.355447,20260921220959,0334,0020,0336,8F3D,00,0.2,20260921220959,03C9',
    exit:
      '+RESP:GTGEO,270D04,863457050476769,,,00,1,1,3.3,79,2258.0,-99.127571,19.355516,20260921221159,0334,0020,2C1A,90489A1,00,0.2,20260921221159,03CD',
  },
  GV310LAU: {
    enter:
      '+RESP:GTGIN,6E0A03,868589060960328,,,0,1,00000001,,,,,1,1,0.0,0,2248.0,-99.128239,19.355355,20260925002252,0334,0020,024A,015FAD2B,00,0.0,20260925002253,01F9',
    exit:
      '+RESP:GTGOT,6E0A03,868589060960328,,,0,1,00000001,,,,,1,1,0.0,0,2249.8,-99.128245,19.355360,20260925002356,0334,0020,024A,015FAD2B,00,0.0,20260925002357,0206',
  },
};

const log = (...args) => console.log(new Date().toISOString(), ...args);
const sql = (imei, trama) =>
  `INSERT INTO reporte_cadenas (imei, trama) VALUES ('${imei}', '${trama}');`;
const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
let counter = 0;
const nextCount = () => (++counter).toString(16).toUpperCase().padStart(4, '0');

for (const dev of DEVICES) {
  const socket = dgram.createSocket('udp4');

  socket.on('error', (err) => {
    console.error(`[${dev.model}] error en el puerto ${dev.port}:`, err.message);
    process.exit(1);
  });

  socket.on('message', (msg, rinfo) => {
    const text = msg.toString('utf8');
    if (!text.startsWith('AT+GTGEO=')) {
      log(`[${dev.model}] mensaje inesperado de ${rinfo.address}:${rinfo.port}: ${text}`);
      return;
    }
    // AT+GTGEO=<modelo>,<id>,<mode>,<lon>,<lat>,<radio>,...,<serial>$
    const fields = text.replace(/^AT\+GTGEO=/, '').replace(/\$\s*$/, '').split(',');
    const mode = fields[2];
    const serial = fields[fields.length - 1];
    const kind = mode === '0' ? 'RESET (Mode=0)' : `SITIO (Mode=${mode})`;

    log(`[${dev.model}] comando recibido — ${kind}, serial ${serial}`);
    console.log(`  ${text}`);
    const ack = `+ACK:GTGEO,${dev.header},${dev.imei},,0,${serial},${stamp()},${nextCount()}`;
    console.log('  Para responder el ACK, pega en psql:');
    console.log(`  ${sql(dev.imei, ack)}\n`);
  });

  socket.bind(dev.port, '127.0.0.1', () => {
    log(`[${dev.model}] escuchando en 127.0.0.1:${dev.port} (IMEI ${dev.imei})`);
  });
}

console.log('\n--- Chuleta de SQL (pégala en psql cuando la necesites) ---');
for (const dev of DEVICES) {
  console.log(`\n${dev.model} (${dev.imei})`);
  console.log(`  entrada: ${sql(dev.imei, SAMPLES[dev.model].enter)}`);
  console.log(`  salida:  ${sql(dev.imei, SAMPLES[dev.model].exit)}`);
}
console.log('\nEl ACK se imprime cuando llegue cada comando. Ctrl+C para salir.\n');
