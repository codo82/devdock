// Server-Sent Events: apre la risposta in streaming e restituisce send(type, data)
function openSse(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (type, data) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  };
  send.end = () => { if (!res.writableEnded) res.end(); };
  return send;
}

module.exports = { openSse };
