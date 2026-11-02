// Server-Sent Events hub.
const clients = new Set();
let seq = 0;
function subscribe(req, res, filter = {}) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ connected: true, clients: clients.size + 1, t: new Date().toISOString() })}\n\n`);
  const c = { res, filter };
  clients.add(c);
  const hb = setInterval(() => res.write(': hb\n\n'), 15000);
  req.on('close', () => { clearInterval(hb); clients.delete(c); });
}
function publish(incident, change = 'update') {
  const payload = JSON.stringify({ ...incident, _change: change });
  seq++;
  for (const c of clients) {
    if (c.filter.fleetId && c.filter.fleetId !== incident.fleetId) continue;
    c.res.write(`id: ${seq}\nevent: incident\ndata: ${payload}\n\n`);
  }
}
// generic named event (e.g. 'alert') for other modules
function publishEvent(name, data, filter = {}) {
  seq++;
  const payload = JSON.stringify(data);
  for (const c of clients) {
    if (c.filter.fleetId && filter.fleetId && c.filter.fleetId !== filter.fleetId) continue;
    c.res.write(`id: ${seq}\nevent: ${name}\ndata: ${payload}\n\n`);
  }
}
module.exports = { publishEvent, subscribe, publish, count: () => clients.size };
