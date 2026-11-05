// Generates placeholder dashcam frames (SVG) so the demo has "camera evidence" without real video.
const { hashStr } = require('./util');
function frame(inc, type = 'road', opts = {}) {
  const h = hashStr((inc && inc.id) || 'x');
  const sky = ['#2b3a55', '#3a4a6b', '#46506a', '#1f2c45'][h % 4];
  const coll = opts.phase !== 'before' && inc && (inc.eventType === 'collision' || inc.eventType === 'rollover') && inc.camera.aiVerdict !== 'false_positive';
  const v = (inc && inc.camera.aiVerdict) || 'event';
  const sp = inc ? inc.location.speed_mph : 0;
  const ts = inc ? inc.timestamp.replace('T', ' ').slice(0, 19) + 'Z' : '';
  const carX = 280 + (h % 80), carW = 110;
  const driver = type === 'driver';
  const body = driver
    ? `<rect width="640" height="360" fill="#1c1f26"/><circle cx="320" cy="160" r="70" fill="#8d7a68"/><rect x="250" y="220" width="140" height="140" rx="30" fill="#2d3646"/><rect x="285" y="140" width="25" height="8" fill="#222"/><rect x="335" y="140" width="25" height="8" fill="#222"/>`
    : `<rect width="640" height="360" fill="${sky}"/><rect y="150" width="640" height="210" fill="#2e3138"/><polygon points="250,150 390,150 640,360 0,360" fill="#3b3e46"/><polygon points="318,150 322,150 340,360 300,360" fill="#d8c24a"/>
       <rect x="${carX}" y="${coll ? 150 : 140}" width="${carW}" height="${coll ? 62 : 48}" rx="6" fill="${coll ? '#8c2a2a' : '#5a5f6b'}"/><rect x="${carX + 12}" y="${coll ? 158 : 148}" width="${carW - 24}" height="14" fill="#9db4cf" opacity=".6"/>
       ${coll ? '<polygon points="320,200 345,230 330,232 350,262 316,238 300,262 304,230 280,222" fill="#ffb02e" opacity=".9"/>' : ''}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" width="640" height="360">${body}
<rect width="640" height="26" fill="#000" opacity=".55"/><text x="10" y="18" font-family="monospace" font-size="13" fill="#fff">${type === 'driver' ? 'DRIVER-FACING' : 'ROAD-FACING'}${opts.tag ? '  ' + opts.tag : ''}  ${ts}  ${sp != null ? sp + ' mph' : ''}</text>
<rect y="334" width="640" height="26" fill="#000" opacity=".55"/><text x="10" y="352" font-family="monospace" font-size="13" fill="#ff8a3d">NEXUS DEMO FRAME  ${inc ? inc.id : ''}  AI: ${String(v).replace(/_/g, ' ').toUpperCase()}</text></svg>`;
}
module.exports = { frame };
