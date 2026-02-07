// Stripe webhook handler (placeholder — works with test mode)
module.exports = (req, res) => {
  const event = JSON.parse(req.body);
  console.log('Stripe webhook:', event.type);
  res.json({ received: true });
};
