/**
 * Sigmakee interface code for extension
 */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const { getSigmaHome, getSigmaPath, getSigmaRuntime } = require('./engine');
const { runSigma } = require('./runner');
const { findConfigXml, isWithinConfiguredKB, getKBConstituentsFromConfig } = require('./config');

module.exports = {
    getSigmaPath,
    getSigmaHome,
    findConfigXml,
    isWithinConfiguredKB,
    getKBConstituentsFromConfig,
    runSigma,
    getSigmaRuntime
};
