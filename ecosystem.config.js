module.exports = {
  apps: [
    {
      name: 'hr-management-backend',
      script: 'src/index.ts',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      node_args: [
        '--max-old-space-size=4096',
        '--expose-gc',
        '-r',
        'ts-node/register/transpile-only'
      ],
      max_memory_restart: '3G',
      watch: false
    }
  ]
};