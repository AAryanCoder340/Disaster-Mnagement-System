const clients = new Set();

function addClient(res) {
  clients.add(res);
  res.on('close', () => {
    clients.delete(res);
  });
}

function broadcast(event, payload) {
  const body = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(body);
    } catch (_error) {
      clients.delete(res);
    }
  }
}

function clientCount() {
  return clients.size;
}

module.exports = {
  addClient,
  broadcast,
  clientCount
};
