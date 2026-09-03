import { validateProductionConfig } from '../src/platform/operations/production-config.js';

const result = validateProductionConfig();
console.log(JSON.stringify(result));
if (!result.valid) process.exitCode = 2;
