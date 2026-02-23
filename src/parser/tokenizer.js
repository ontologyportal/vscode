/**
 * SUMO Tokenizer
 * Converts SUMO source text into a stream of tokens
 */

const charSet = {
    upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
    lower: 'abcdefghijklmnopqrstuvwxyz'.split(''),
    digit: '0123456789'.split(''),
    special: '!$%&*+-./<=>?@_~'.split(''),
    white: ' \t\r\n\f'.split(''),
    get initialChar() { return this.upper.concat(this.lower) },
    get wordChar() { return this.upper.concat(this.lower, this.digit, ['-', '_']) },
    get character() { return this.upper.concat(this.lower, this.digit, this.special, this.white) },
}

const TokenType = {
    LPAREN: 'LPAREN',
    RPAREN: 'RPAREN',
    ATOM: 'ATOM',
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
 * @returns {Token[]} Array of token objects
 */
function tokenize(text, file = 'unknown') {
    /** @type {Token[]} */
    const tokens = [];
    let offset = 0; // Track the global offset
    const lines = text.split("\n");
    // Iterate through the lines
    for (let row = 0; row < lines.length; ++row) {
        for (let col = 0; col < lines[row].length; col++) {
            // Get the current character
            const char = lines[row][col];
            const line = lines[row];
            const len = line.length;
    
            // Skip whitespace
            if (/\s/.test(char)) {
                offset++;
                continue;
            }
    
            // Skip comments (semicolon to end of line)
            if (char === ';') {
                offset += len - col + 1;
                break;
            }
    
            // String literal, they may span multiple lines
            if (char === '"') {
                const start = offset; // Starting offset in document
                const startRow = row; // Starting line in document
                const startCol = col; // Starting col in document
                offset++; // Skip the opening quote
                while (offset < text.length) {
                    if (text[offset] === '"') { // End of string
                        offset++;
                        break;
                    }
                    if (text[offset] === "\n") { // Newline
                        row += 1;
                        col = 0; // Reset column, iterate the row
                    } else if (!charSet.character.includes(text[offset]) && text[offset] !== '"') {
                        throw new TokenizerError(row, col, `Illegal character in string literal: ${text[offset]}`, file)
                    }
                    offset++;
                }
                // Update col to end of string on current line
                col = offset - start + startCol - 1;
                tokens.push(new Token(
                    TokenType.STRING,
                    startRow,
                    startCol,
                    start,
                    text.substring(start, offset).replace(/\n/g, " "),
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
            while (col < len && !/\s/.test(line[col]) && line[col] !== '(' && line[col] !== ')' && line[col] !== '"') {
                col++;
                offset++;
            }

            const value = line.substring(startCol, col);
    
            // Determine token type
            let type = TokenType.ATOM;
    
            if (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(value)) {
                type = TokenType.NUMBER;
            } else {
                let firstChar = value.at(1);
                if (value.startsWith('?')) {
                    type = TokenType.VARIABLE;
                } else if (value.startsWith('@')) {
                    type = TokenType.ROW_VARIABLE;
                } else {
                    firstChar = value.at(0);
                }
                if (!charSet.initialChar.includes(firstChar)) {
                    // Initial character is wrong
                    throw new TokenizerError(
                        row,
                        col,
                        `Symbols must start with a lower or uppercase character (after any variable indicator): ${value}`,
                        file
                    );
                }
            }
            
            tokens.push(new Token(type, row, startCol, start, value, file));
            col--; // Adjust for the for loop increment
        }
        offset++; // Account for newline character
    }

    return tokens;
}

module.exports = {
    TokenType,
    TokenizerError,
    tokenize,
    Token
};
