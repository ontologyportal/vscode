/* Define important constants relating to SUMO/Sigma */

// These are primitives
const LOGIC_OPS = ['and', 'or', 'not', '=>', '<=>'];
const QUANTIFIERS = ['forall', 'exists'];

// While these are not primitives, they are vital to our 
//  parsing and understanding of the KB
const DEFINING_RELATIONS = [
    'instance', 
    'subclass',
    'subrelation',
    'domain',
    'domainSubclass',
    'range',
    'rangeSubclass',
    'documentation',
    'format',
    'termFormat'
];

module.exports = {
    LOGIC_OPS,
    QUANTIFIERS,
    DEFINING_RELATIONS
}