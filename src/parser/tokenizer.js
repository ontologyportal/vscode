/**
 * SUO-KIF Tokenizer
 * Converts SUO-KIF source text into a stream of tokens
 */

const TokenType = {
    LPAREN: 'LPAREN',
    RPAREN: 'RPAREN',
    ATOM: 'ATOM',
    STRING: 'STRING',
    NUMBER: 'NUMBER',
    VARIABLE: 'VARIABLE',
    ROW_VARIABLE: 'ROW_VARIABLE'
};

/**
 * Tokenize SUO-KIF text into tokens
 * @param {string} text - SUO-KIF source text
 * @returns {Array} Array of token objects
 */
function tokenize(text) {
    const tokens = [];
    let i = 0;

    while (i < text.length) {
        const char = text[i];

        // Skip whitespace
        if (/\s/.test(char)) {
            i++;
            continue;
        }

        // Skip comments (semicolon to end of line)
        if (char === ';') {
            while (i < text.length && text[i] !== '\n') i++;
            continue;
        }

        // String literal
        if (char === '"') {
            const start = i;
            i++;
            while (i < text.length) {
                if (text[i] === '\\') {
                    i += 2;
                    continue;
                }
                if (text[i] === '"') {
                    i++;
                    break;
                }
                i++;
            }
            tokens.push({
                type: TokenType.STRING,
                value: text.substring(start, i),
                offset: start
            });
            continue;
        }

        // Left parenthesis
        if (char === '(') {
            tokens.push({ type: TokenType.LPAREN, offset: i });
            i++;
            continue;
        }

        // Right parenthesis
        if (char === ')') {
            tokens.push({ type: TokenType.RPAREN, offset: i });
            i++;
            continue;
        }

        // Atom, number, or variable
        const start = i;
        while (i < text.length && !/\s/.test(text[i]) && text[i] !== '(' && text[i] !== ')' && text[i] !== '"') {
            i++;
        }

        const value = text.substring(start, i);

        // Determine token type
        let type = TokenType.ATOM;

        if (value.startsWith('?')) {
            type = TokenType.VARIABLE;
        } else if (value.startsWith('@')) {
            type = TokenType.ROW_VARIABLE;
        } else if (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(value)) {
            type = TokenType.NUMBER;
        }

        tokens.push({ type, value, offset: start });
    }

    return tokens;
}

module.exports = {
    TokenType,
    tokenize
};
