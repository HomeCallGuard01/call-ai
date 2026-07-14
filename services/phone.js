function normaliseNumber(number) {
  return (number || "").replace(/\D/g, "").slice(-10);
}

module.exports = { normaliseNumber };
