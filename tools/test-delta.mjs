import WebSocket from 'ws';

const log = (name, m) => console.log(name, '->', JSON.stringify(m));

const a = new WebSocket('ws://localhost:8088');
const b = new WebSocket('ws://localhost:8088');

a.on('message', (d) => log('A收到', JSON.parse(d)));
b.on('message', (d) => log('B收到', JSON.parse(d)));

b.on('open', () => {
  setTimeout(() => {
    console.log('--- A 移動自己 ---');
    a.send(JSON.stringify({ type: 'move', x: 400, y: 400 }));
  }, 300);
  setTimeout(() => {
    console.log('--- B 移動到 A 附近 ---');
    b.send(JSON.stringify({ type: 'move', x: 420, y: 420 }));
  }, 600);
  setTimeout(() => process.exit(0), 1500);
});
