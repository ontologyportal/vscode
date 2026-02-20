/**
 * Sigmakee interface code for extension
 */

const { getSigmaHome, getSigmaPath, getSigmaRuntime } = require('./engine');
const { compileKB, compileFormulas  } = require('./compile');
const { findConfigXml, isWithinConfiguredKB, getKBConstituentsFromConfig } = require('./config');

module.exports = {
    getSigmaPath,
    getSigmaHome,
    findConfigXml,
    isWithinConfiguredKB,
    getKBConstituentsFromConfig,
    compileKB,
    compileFormulas,
    getSigmaRuntime
};
