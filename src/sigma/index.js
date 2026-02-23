/**
 * Sigmakee interface code for extension
 */

const { getSigmaHome, getSigmaPath, getSigmaRuntime } = require('./engine');
const { compileKB, compileFormulas  } = require('./compile');
const { findConfigXml, isWithinConfiguredKB, getKBConstituentsFromConfig } = require('./config');

/**
 * Assert a statement into a knowledge base
 * @param {string} kbName 
 * @param {string} statement 
 * @returns {Promise<string[]>}
 */
async function tell(kbName, statement) {
    return await getSigmaRuntime().tell(kbName, statement);
}

/**
 * Query a knowledge base
 * @param {string} kbName 
 * @param {string} query 
 * @param {object} options 
 * @returns {Promise<object>}
 */
async function ask(kbName, query, options = {}) {
    return await getSigmaRuntime().ask(kbName, query, options);
}

module.exports = {
    getSigmaPath,
    getSigmaHome,
    findConfigXml,
    isWithinConfiguredKB,
    getKBConstituentsFromConfig,
    compileKB,
    compileFormulas,
    getSigmaRuntime,
    ask,
    tell
};
