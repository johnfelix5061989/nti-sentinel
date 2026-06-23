module.exports = {
  apps: [{
    name: 'nti-sentinel',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'development',
      PORT: 3000
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000
    }
  }]
};
