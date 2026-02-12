/**
 * String utility functions
 * Ported from StringUtil.java
 *
 * This code is copyright Articulate Software (c) 2003.
 * This software is released under the GNU Public License
 * <http://www.gnu.org/copyleft/gpl.html>.
 */

/**
 * Check if a string is empty or null/undefined
 * @param {*} s - The value to check
 * @returns {boolean} true if empty, null, or undefined
 */
function emptyString(s) {
    return s === null || s === undefined || s === '';
}

/**
 * Check if a string is non-empty
 * @param {*} s - The value to check
 * @returns {boolean} true if non-empty
 */
function isNonEmptyString(s) {
    return !emptyString(s);
}

/**
 * Check if a string represents a numeric value
 * @param {string} s - The string to check
 * @returns {boolean} true if the string is numeric
 */
function isNumeric(s) {
    if (emptyString(s)) {
        return false;
    }
    const str = s.trim();
    if (str === '') {
        return false;
    }
    // Handle negative numbers
    const numStr = str.startsWith('-') ? str.substring(1) : str;
    if (numStr === '') {
        return false;
    }
    // Check if all remaining characters are digits or a single decimal point
    let hasDecimal = false;
    for (let i = 0; i < numStr.length; i++) {
        const ch = numStr.charAt(i);
        if (ch === '.') {
            if (hasDecimal) {
                return false; // Multiple decimal points
            }
            hasDecimal = true;
        } else if (ch < '0' || ch > '9') {
            return false;
        }
    }
    return true;
}

/**
 * Check if a string is a quoted string (starts and ends with quotes)
 * @param {string} s - The string to check
 * @returns {boolean} true if the string is quoted
 */
function isQuotedString(s) {
    if (emptyString(s)) {
        return false;
    }
    const str = s.trim();
    if (str.length < 2) {
        return false;
    }
    const firstChar = str.charAt(0);
    const lastChar = str.charAt(str.length - 1);
    return (firstChar === '"' && lastChar === '"') ||
           (firstChar === "'" && lastChar === "'");
}

/**
 * Remove enclosing quotes from a string
 * @param {string} s - The string to process
 * @returns {string} The string without enclosing quotes
 */
function removeEnclosingQuotes(s) {
    if (isQuotedString(s)) {
        return s.substring(1, s.length - 1);
    }
    return s;
}

module.exports = {
    emptyString,
    isNonEmptyString,
    isNumeric,
    isQuotedString,
    removeEnclosingQuotes
};
