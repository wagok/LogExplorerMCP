/**
 * Генератор тестовых логов для демонстрации
 */

const fs = require('fs');

const levels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
const components = ['main', 'worker-1', 'worker-2', 'db', 'cache', 'api'];

const templates = [
  { level: 'INFO', weight: 40, template: (c, t) => `${t} INFO  [${c}] Application started successfully` },
  { level: 'INFO', weight: 30, template: (c, t) => `${t} INFO  [${c}] Processing request id=${Math.floor(Math.random() * 100000)}` },
  { level: 'INFO', weight: 20, template: (c, t) => `${t} INFO  [${c}] User ${['john', 'admin', 'guest', 'alice', 'bob'][Math.floor(Math.random() * 5)]} logged in from ${randomIP()}` },
  { level: 'DEBUG', weight: 50, template: (c, t) => `${t} DEBUG [${c}] Cache ${['hit', 'miss'][Math.floor(Math.random() * 2)]} for key: user:${Math.floor(Math.random() * 1000)}` },
  { level: 'DEBUG', weight: 30, template: (c, t) => `${t} DEBUG [${c}] Query executed in ${Math.floor(Math.random() * 100)}ms` },
  { level: 'WARN', weight: 10, template: (c, t) => `${t} WARN  [${c}] Memory usage high: ${75 + Math.floor(Math.random() * 20)}%` },
  { level: 'WARN', weight: 8, template: (c, t) => `${t} WARN  [${c}] Slow response time: ${500 + Math.floor(Math.random() * 2000)}ms` },
  { level: 'WARN', weight: 5, template: (c, t) => `${t} WARN  [${c}] Connection pool exhausted, waiting...` },
  { level: 'ERROR', weight: 3, template: (c, t) => `${t} ERROR [${c}] Connection failed to ${['database', 'cache', 'message-queue', 'auth-service'][Math.floor(Math.random() * 4)]}` },
  { level: 'ERROR', weight: 2, template: (c, t) => `${t} ERROR [${c}] NullPointerException in ${['UserService', 'OrderService', 'PaymentService'][Math.floor(Math.random() * 3)]}.process()` },
  { level: 'ERROR', weight: 1, template: (c, t) => `${t} ERROR [${c}] Request timeout after 30000ms` },
];

function randomIP() {
  return `${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
}

function weightedRandom(items) {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  let random = Math.random() * totalWeight;
  
  for (const item of items) {
    random -= item.weight;
    if (random <= 0) return item;
  }
  return items[0];
}

function generateLogs(count, options = {}) {
  const { 
    startTime = new Date('2024-01-15T10:00:00'),
    durationMinutes = 60,
    errorSpike = { start: 30, duration: 10, multiplier: 5 } // Спайк ошибок
  } = options;
  
  const logs = [];
  const msPerLog = (durationMinutes * 60 * 1000) / count;
  
  for (let i = 0; i < count; i++) {
    const timestamp = new Date(startTime.getTime() + i * msPerLog);
    const minutesSinceStart = (timestamp - startTime) / 1000 / 60;
    
    // Имитируем спайк ошибок
    let templatePool = templates;
    if (minutesSinceStart >= errorSpike.start && minutesSinceStart < errorSpike.start + errorSpike.duration) {
      templatePool = templates.map(t => 
        t.level === 'ERROR' 
          ? { ...t, weight: t.weight * errorSpike.multiplier }
          : t
      );
    }
    
    const template = weightedRandom(templatePool);
    const component = components[Math.floor(Math.random() * components.length)];
    const ts = timestamp.toISOString().replace('T', ' ').substring(0, 19);
    
    logs.push(template.template(component, ts));
  }
  
  return logs;
}

// Генерируем тестовый файл
const lines = generateLogs(1000, {
  startTime: new Date('2024-01-15T10:00:00'),
  durationMinutes: 120,
  errorSpike: { start: 60, duration: 15, multiplier: 10 }
});

const outFile = process.argv[2] || '/tmp/test-app.log';
fs.writeFileSync(outFile, lines.join('\n'));
console.log(`Generated ${lines.length} log lines to ${outFile}`);
