/**
 * SUMO Tokenizer
 * Converts SUMO source text into a stream of tokens
 */

// Pre-computed Sets for O(1) character/operator classification.
// The getters in the old charSet allocated new arrays on every access;
// these are computed once at module load time.
const _alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const charSet = {
    initialChar: new Set(_alpha),
    operators: new Set([ 'and', 'or', 'not', 'exists', 'forall', '=>', '<=>', 'equal' ]),
};

// Pre-compiled number regex — avoids re-compiling on every token.
const NUMBER_RE = /^-?\d+(\.\d+)?(e-?\d+)?$/i;

const TokenType = {
    LPAREN: 'LPAREN',
    RPAREN: 'RPAREN',
    ATOM: 'ATOM',
    OPERATOR: 'OPERATOR',
    STRING: 'STRING',
    NUMBER: 'NUMBER',
    VARIABLE: 'VARIABLE',
    ROW_VARIABLE: 'ROW_VARIABLE'
};

class Token {
    /**
     * @param {TokenType} type The type of the token
     * @param {number} line The line this token appears on in the source document
     * @param {number} column The offset of the token on its line
     * @param {number} offset The offset of this token in the global document
     * @param {string|undefined} value The original value of the token
     * @param {string} file The file this token belongs to
    */
    constructor(type, line, column, offset, value, file) {
        /** @type {TokenType} */
        this.type = type;
        /** @type {string|undefined} */
        this.value = value;
        /** @type {number} */
        this.line = line;
        /** @type {number} */
        this.column = column;
        /** @type {number} */
        this.offset = offset;
        /** @type {string} */
        this.file = file;
    }
}

class TokenizerError extends Error {
    /**
     * @param {number} line 
     * @param {number} col 
     * @param {string} error 
     * @param {string} file
     */
    constructor (line, col, error, file) {
        super(`[${file}:${line}:${col}] ${error}`);
        this.name = this.constructor.name;
        this.line = line;
        this.col = col;
        this.error = error;
        this.file = file;
    }
}

/**
 * Tokenize SUMO text into tokens
 * @param {string} text - SUMO source text
 * @param {string} file - The filename being tokenized
 * @returns {{tokens: Token[], errors: TokenizerError[]}} Array of token objects
 */
function tokenize(text, file = 'unknown') {
    /** @type {Token[]} */
    const tokens = [];
    /** @type {TokenizerError[]} */
    const errors = [];
    let offset = 0; // Track the global offset
    const lines = text.split("\n");
    // Iterate through the lines
    for (let row = 0; row < lines.length; row++) {
        for (let col = 0; col < lines[row].length; col++) {
            // Get the current character
            const char = lines[row][col];
            const line = lines[row];
            const len = line.length;
    
            // Skip whitespace — char <= ' ' covers space, tab, CR, LF, FF
            // and is measurably faster than a regex test in a tight loop.
            if (char <= ' ') {
                offset++;
                continue;
            }
    
            // Skip comments (semicolon to end of line)
            if (char === ';') {
                offset += len - col;
                break;
            }
    
            // String literal, they may span multiple lines
            if (char === '"') {
                const start = ++offset; // Starting offset in document
                const startRow = row; // Starting line in document
                const startCol = ++col; // Starting col in document
                while (offset < text.length) {
                    if (text[offset] === '"') { // End of string
                        break;
                    }
                    if (text[offset] === "\\") { // escape sequence, skip the next character
                        offset += 2;
                        col += 2;
                        continue;
                    }
                    if (text[offset] === "\n") { // Newline
                        row += 1; // iterate row
                        offset++; // consume
                        col = 0; // reset column
                        continue;
                    }
                    // else if (!charSet.character.includes(text[offset])) {
                    //     errors.push(
                    //         new TokenizerError(
                    //             row,
                    //             col, 
                    //             `Illegal character in string literal: ${text[offset]}`, file
                    //         )
                    //     );
                    //     // Consume anyway
                    // }
                    offset++;
                    col++;
                }
                // replace newlines with spaces
                tokens.push(new Token(
                    TokenType.STRING,
                    startRow,
                    startCol,
                    start,
                    text.substring(start, offset++).replace(/\n/g, " "),
                    file
                ));
                continue;
            }
    
            // Left parenthesis
            if (char === '(') {
                tokens.push(new Token(
                    TokenType.LPAREN,
                    row,
                    col,
                    offset++,
                    '(',
                    file
                ));
                continue;
            }
    
            // Right parenthesis
            if (char === ')') {
                tokens.push(new Token(
                    TokenType.RPAREN,
                    row,
                    col,
                    offset++,
                    ')',
                    file
                ));
                continue;
            }
    
            // Atom, number, or variable
            const start = offset;
            const startCol = col;
            // Consume until you hit the end of the line, whitespace, a parenthesis or a quote
            while (col < len && line[col] > ' ' && line[col] !== '(' && line[col] !== ')' && line[col] !== '"') {
                col++;
                offset++;
            }

            const value = line.substring(startCol, col);
    
            // Determine token type
            let type = TokenType.ATOM;

            if (NUMBER_RE.test(value)) {
                type = TokenType.NUMBER;
            } else if (value.startsWith('?')) {
                type = TokenType.VARIABLE;
                if (!charSet.initialChar.has(value.at(1))) {
                    errors.push(new TokenizerError(
                        row, startCol,
                        `Variable name must start with a letter after '?': ${value}`,
                        file
                    ));
                }
            } else if (value.startsWith('@')) {
                type = TokenType.ROW_VARIABLE;
                if (!charSet.initialChar.has(value.at(1))) {
                    errors.push(new TokenizerError(
                        row, startCol,
                        `Row variable name must start with a letter after '@': ${value}`,
                        file
                    ));
                }
            } else if (charSet.operators.has(value)) {
                type = TokenType.OPERATOR;
            } else if (charSet.initialChar.has(value.at(0))) {
                type = TokenType.ATOM;
            } else {
                errors.push(new TokenizerError(
                    row, startCol,
                    `Symbols must start with a lower or uppercase character (after any variable indicator): ${value}`,
                    file
                ));
            }
            
            tokens.push(new Token(type, row, startCol, start, value, file));
            col--; // Adjust for the for loop increment
        }
        offset++; // Account for newline character
    }

return {tokens, errors};
}

module.exports = {
    TokenType,
    TokenizerError,
    tokenize,
    Token
};
