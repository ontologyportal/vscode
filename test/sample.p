% Sample TPTP file demonstrating syntax highlighting
% This is a line comment

/*
 * This is a block comment
 * demonstrating multi-line comments
 */

% Include directive
include('Axioms/SET006+0.ax').

% First-order form axioms
fof(subset_definition, axiom,
    ! [A, B] : (subset(A, B) <=> ! [X] : (member(X, A) => member(X, B)))).

fof(empty_set_axiom, axiom,
    ! [X] : ~ member(X, empty_set)).

% Typed first-order form with type declaration
tff(human_type, type, human: $tType).
tff(age_type, type, age: human > $int).

tff(age_positive, axiom,
    ! [H: human] : $greater(age(H), 0)).

% Higher-order form example
thf(and_type, type, and: ($o > ($o > $o))).

thf(and_commutativity, axiom,
    ! [P: $o, Q: $o] : ((and @ P @ Q) <=> (and @ Q @ P))).

% Clause normal form
cnf(clause_1, axiom,
    ( ~ human(X) | mortal(X) )).

cnf(socrates_human, axiom,
    human(socrates)).

% Conjecture to prove
fof(socrates_mortal, conjecture,
    mortal(socrates)).

% Theorem (already proven)
fof(set_equality, theorem,
    ! [A, B] : ((subset(A, B) & subset(B, A)) => equal(A, B))).

% Arithmetic examples
tff(sum_example, axiom,
    $sum(2, 3) = 5).

tff(comparison_example, axiom,
    $less(1, 2) & $greatereq(5, 5)).

% Distinct objects (strings)
fof(distinct_example, axiom,
    $distinct("apple", "orange", "banana")).

% Single-quoted atom
fof(quoted_example, axiom,
    'has space'(X, Y) => related(X, Y)).

% Variables (uppercase)
fof(variable_example, axiom,
    ! [X, Y, Z] : (related(X, Y) & related(Y, Z) => related(X, Z))).
