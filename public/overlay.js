let currentState;
const $ = (selector) => document.querySelector(selector);
function time(milliseconds) { const seconds = Math.floor(milliseconds / 1000); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; }
function render() {
  if (!currentState) return;
  const { match } = currentState;
  $('#overlay-home').textContent = match.home;
  $('#overlay-away').textContent = match.away;
  $('#overlay-home-score').textContent = match.homeScore;
  $('#overlay-away-score').textContent = match.awayScore;
  $('#overlay-period').textContent = match.period;
  $('#overlay-clock').textContent = time(match.clock.elapsedMs);
}
function connect() {
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket.onmessage = (event) => { const message = JSON.parse(event.data); if (message.type === 'state') { currentState = message.state; render(); } };
  socket.onclose = () => setTimeout(connect, 1500);
}
connect();
