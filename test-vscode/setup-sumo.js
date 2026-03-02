'use strict';

/**
 * Ensures the ontologyportal/sumo repository is available locally.
 *
 * Resolution order for the target path:
 *   1. SUMO_PATH environment variable
 *   2. ../sumo relative to this project (i.e. a sibling directory)
 *
 * If the directory does not exist, the repo is shallow-cloned.
 * The cloned directory is NOT inside the project and is NOT committed.
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SUMO_REPO    = 'https://github.com/ontologyportal/sumo';
const DEFAULT_PATH = path.resolve(__dirname, '../../sumo');

async function ensureSumo() {
    const sumoPath = process.env.SUMO_PATH || DEFAULT_PATH;

    if (fs.existsSync(sumoPath)) {
        console.log(`[setup-sumo] Found SUMO repo at ${sumoPath}`);
        return sumoPath;
    }

    console.log(`[setup-sumo] SUMO repo not found at ${sumoPath}`);
    console.log(`[setup-sumo] Cloning ${SUMO_REPO} …`);
    execSync(`git clone --depth=1 "${SUMO_REPO}" "${sumoPath}"`, { stdio: 'inherit' });
    console.log(`[setup-sumo] Clone complete → ${sumoPath}`);
    return sumoPath;
}

module.exports = { ensureSumo };
