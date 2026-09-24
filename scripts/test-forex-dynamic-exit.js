// Run the read-only MT5 diagnostic with dynamic exits temporarily enabled.

process.env.FOREX_DYNAMIC_EXIT_ENABLED = 'true';
await import('./test-forex-optimizer.js');
