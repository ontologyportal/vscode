/** Test for sentences */
const sinon = require("sinon");
const { expect } = require('chai');
const { TokenList, NodeType, ASTListNode, ASTTermNode } = require('../../src/parser/parser');
const { tokenize } = require('../../src/parser/tokenizer');
const { Sentence, scope, VariableSym, OperatorSentence } = require('../../src/parser/sentence');
const { ELEMENT_TYPE } = require('../../src/parser/element');
const { Symbol } = require('../../src/parser/symbol');
const { OrOperator, Operator, AndOperator, ExistsOperator, ConditionalOperator } = require("../../src/parser/operator");
/**
 * Run the full tokenize → parse → syntax pipeline on a KIF string.
 * @param {string} text
 */
function toNode(text) {
    const { tokens } = tokenize(text, 'test.kif');
    const list = new TokenList(tokens);
    return list.parse();
}

describe('Sentence', function() {
    describe('scope', function() {
        it('should create an Proxied object', function() {
            const newScope = scope({});

            expect(newScope).to.be.a("object");
        });

        it('should behave like an object', function() {
            const newScope = scope({});

            expect(newScope).to.not.have.key("something");
            newScope["something"] = "foo";
            expect(newScope).to.have.key("something");
            expect(newScope["something"]).to.be.equal("foo");
        });

        it('should make two independent objects', function() {
            const newScopeA = scope({});
            const newScopeB = scope({});

            newScopeA["something"] = "foo";
            expect(newScopeA).to.have.key("something");
            expect(newScopeA["something"]).to.be.equal("foo");
            expect(newScopeB).to.not.have.key("something");
        });

        it('should not override existing values', function() {
            const newScope = scope({});

            newScope.something = "foo";
            newScope.something = "bar";
            expect(newScope["something"]).to.be.equal("foo");
        });

        it('should perform lookup on parent scopes if the symbol does not exist in the target scope', function() {
            const parentSentence = {};
            const childSentence = {parent: parentSentence};

            const parentScope = scope(parentSentence);
            const childScope = scope(childSentence);

            parentSentence.scope = parentScope;
            childSentence.scope = childScope;

            parentScope.test = "foo";
            expect(parentScope.test).to.equal("foo");
            expect(childScope.test).to.equal("foo");
        });

        it('child scope variables are not accesible from the parent', function() {
            const parentSentence = {};
            const childSentence = {parent: parentSentence};

            const parentScope = scope(parentSentence);
            const childScope = scope(childSentence);

            parentSentence.scope = parentScope;
            childSentence.scope = childScope;

            childScope.test = "foo";
            expect(parentScope.test).not.to.equal("foo");
            expect(childScope.test).to.equal("foo");
        });

        it('child scope variables with the same name are overwritten from the parent', function() {
            const parentSentence = {};
            const childSentence = {parent: parentSentence};

            const parentScope = scope(parentSentence);
            const childScope = scope(childSentence);

            parentSentence.scope = parentScope;
            childSentence.scope = childScope;

            parentScope.test = "foo";
            childScope.test = "bar";
            expect(parentScope.test).to.equal("foo");
            expect(childScope.test).to.equal("bar");
        });
    });

    describe('VariableSym', function() {
        it('should have a property $TYPE which returns ELEMENT_TYPE.VARIABLE', function () {
            const variable = new VariableSym('?A');
            expect(variable.$TYPE).to.be.equal(ELEMENT_TYPE.VARIABLE);
        });

        it('should have NodeType.ROW_VARIABLE/VARIABLE as a return from nodeTypes', function () {
            const variable = new VariableSym('?A');
            expect([...variable.nodeTypes]).to.have.members([NodeType.ROW_VARIABLE, NodeType.VARIABLE]);
        });
    });

    describe('Sentence constructor', function() {
        it("should error if the provided node is not an instance of ASTListNode", function() {
            const { nodes } = toNode('(A A)');
            /** @type {ASTListNode} */
            const aSentence = nodes[0];
            const notASentence = aSentence.children[0];

            expect(() => {
                new Sentence(notASentence);
            }).to.throw("Provided node does not match expected NodeType: Sentence");

            expect(() => {
                new Sentence(aSentence);
            }).not.to.throw("Provided node does not match expected NodeType: Sentence");
        });

        it("should create a new scope if no parent is specified", function() {
            const { nodes } = toNode('(A A)');
            /** @type {ASTListNode} */
            const aSentence = nodes[0];

            const sentence = new Sentence(aSentence);

            expect(sentence.scope).to.be.a('object');
        });

        it("should inherit the scope of its parent if specified", function() {
            const { nodes } = toNode('(A A (A A))');
            /** @type {ASTListNode} */
            const aSentence = nodes[0];
            /** @type {ASTListNode} */
            const childSentence = aSentence.children[2];
        
            const sentence = new Sentence(aSentence);
            const child = new Sentence(childSentence, sentence);

            expect(sentence.scope).to.be.a('object');
            expect(child.scope).to.be.a('object');
            expect(sentence.scope).to.equal(child.scope);

            sentence.scope.a = 'foo';
            expect(child.scope.a).to.equal('foo');
        });
    });

    describe('Sentence class', function() {
        beforeEach(function () {
            const { nodes } = toNode('(A A (A A A))');
            this.currentTest.sentence = new Sentence(nodes[0]);
            this.currentTest.sandbox = sinon.createSandbox();
        });

        afterEach(function () {
            this.currentTest.sandbox.restore();
        });
        
        it ("should have a property $TYPE which equals ELEMENT_TYPE.SENTENCE", function() {
            expect(this.test.sentence.$TYPE).to.equal(ELEMENT_TYPE.SENTENCE);
        });

        it ("should have a property nodeTypes which equals [NodeType.LIST]", function() {
            expect([...this.test.sentence.nodeTypes]).to.have.members([NodeType.LIST]);
        });

        it ("should have a property arity which is equal to Infinity by default", function() {
            expect(this.test.sentence.arity).to.equal(Infinity);
        });

        it ("should have a property childNodes which is equal to the nodes of the source node children", function() {
            expect(this.test.sentence.childNodes).to.equal(this.test.sentence.node.children);
        });

        it ("should have a property length which is equal to the number nodes even if childNodes is overridden", function() {
            expect(this.test.sentence.length).to.equal(this.test.sentence.node.children.length);
        });

        it ("should have a property terms which is initially empty", function() {
            expect(this.test.sentence.terms).to.be.empty;
        });

        describe("Sentence.addTerm", function() {
            it ("should throw an error if the term being added is the first term and a Sentence", function() {
                expect(() => {
                    const sentenceNode = this.test.sentence.childNodes[2];
                    this.test.sentence.addTerm(sentenceNode, new Sentence(sentenceNode))
                }).to.throw("Syntax Error: Invalid first term, cannot be a sentence");
                
                expect(() => {
                    const termNode = this.test.sentence.childNodes[0];
                    this.test.sentence.addTerm(termNode, new Symbol("A", {}))
                }).not.to.throw("Syntax Error: Invalid first term, cannot be a sentence");
            });

            it ("should push new terms to terms to the terms array", function() {
                this.test.sentence.addTerm(this.test.sentence.childNodes[0], new Symbol("A", {}));
                this.test.sentence.addTerm(this.test.sentence.childNodes[1], new Symbol("A", {}));
                this.test.sentence.addTerm(this.test.sentence.childNodes[2], new Sentence(this.test.sentence.childNodes[2], this.test.sentence));

                expect(this.test.sentence.terms).to.have.lengthOf(3);
            })
        })

        describe("Sentence.deref", function() {
            it ("should throw an error if not called with null (parent ref)", function() {
                expect(() => {
                    this.test.sentence.deref(1);
                }).to.throw("Unable to dereference the sentence, incorrect parent provided");
            });

            it ("should call the deref on all its terms with the this reference as its argument", function() {
                const ASym = new Symbol("A", {});
                const childSentence = new Sentence(this.test.sentence.childNodes[2], this.test.sentence);

                const ASymDeref = this.test.sandbox.stub(ASym, "deref");
                const childSentenceDeref = this.test.sandbox.stub(childSentence, "deref");
                this.test.sentence.addTerm(this.test.sentence.childNodes[0], ASym);
                this.test.sentence.addTerm(this.test.sentence.childNodes[1], ASym);
                this.test.sentence.addTerm(this.test.sentence.childNodes[2], childSentence);

                this.test.sentence.deref(null);
                expect(ASymDeref.callCount).to.equal(2);
                expect(childSentenceDeref.callCount).to.equal(1);
                expect(childSentenceDeref.calledWith(this.test.sentence)).to.be.true;
            })
        });

        describe("Sentence.inScope", function() {
            it ("should throw an error if not called with a node that is a variable", function() {
                const { nodes } = toNode("A");
                expect(() => {
                    this.test.sentence.inScope(nodes[0]);
                }).to.throw("Syntax Error: Variable term must be either a variable or row variable");
                
                const { varNodes } = toNode("?A");
                expect(() => {
                    this.test.sentence.inScope(varNodes[0]);
                }).not.to.throw("Syntax Error: Variable term must be either a variable or row variable");
            });

            it ("should set the variable in the scope, then call ref on the Variable", function() {
                const refStub = this.test.sandbox.stub(VariableSym.prototype, "ref");
                const { nodes } = toNode("?A");
                const [variable] = nodes;
                
                const addedVar = this.test.sentence.inScope(variable);
                expect(refStub.calledOnce).to.be.true;
                expect(this.test.sentence.scope["?A"]).to.equal(addedVar);
            });

            it ("should perform no updates if the variable is already in scope and return the existing variable", function() {
                const refStub = sinon.stub(VariableSym.prototype, "ref");
                const { nodes } = toNode("?A ?A ?B");
                const [variableA, variableA2, variableB] = nodes;
                
                const addedVar = this.test.sentence.inScope(variableA);
                const addedVar2 = this.test.sentence.inScope(variableA2);
                const addedVar3 = this.test.sentence.inScope(variableB);
                expect(refStub.calledThrice).to.be.true;
                expect(this.test.sentence.scope["?A"]).to.equal(addedVar);
                expect(addedVar).to.equal(addedVar2);
                expect(this.test.sentence.scope["?B"]).to.equal(addedVar3);
            });
        });
    });

    describe('OperatorSentence class', function() {
        beforeEach(function () {
            this.currentTest.sandbox = sinon.createSandbox();
        });

        afterEach(function () {
            this.currentTest.sandbox.restore();
        });
        
        describe ("static new()", function() {
            it ("should raise an error if an unknown operator is passed", function() {
                const sentenceNode = new ASTListNode({});
                sentenceNode.children = [new ASTTermNode(NodeType.OPERATOR, {value: "UNKNOWN"})];
                expect(() => {
                    OperatorSentence.new(sentenceNode);
                }, "Syntax Error: Unknown operator: UNKNOWN");
            });

            it ("returns a new instance OperatorSentence with the correct operator set as its op", function() {
                const {nodes} = toNode("(or (A) (B))");
                const sentence = OperatorSentence.new(nodes[0]);
                expect(sentence).to.be.instanceOf(OperatorSentence);
                expect(sentence.op).to.be.equal(OrOperator);
            });
        });
        describe("constructor", function() {
            it ("takes an operator and assigns it to the op property and push it to terms", function() {
                const {nodes} = toNode("(or (A) (B))");
                const sentence = new OperatorSentence(OrOperator, nodes[0]);
                expect(sentence.op).to.be.equal(OrOperator);
                expect(sentence.terms).to.have.members([OrOperator]);
            });

            it ("calls the passed operators' ref method with the source node", function() {
                const refCall = this.test.sandbox.stub(OrOperator, "ref");
                const {nodes} = toNode("(or (A) (B))");
                const sentence = new OperatorSentence(OrOperator, nodes[0]);
                
                expect(refCall.calledOnce).to.be.true;
                expect(refCall.calledWithExactly(sentence, nodes[0].children[0])).to.be.true;
            });

            it ("should create a new scopes if the operator's scope property is set, or inherit the parent scope if not", function() {
                const {nodes} = toNode("(or (exists (?A) (?A)) (and (A) (B)))");
                const parent = new OperatorSentence(OrOperator, nodes[0]);
                const child = new OperatorSentence(AndOperator, nodes[0].children[2], parent);

                expect(parent.scope).to.equal(child.scope);

                const child2 = new OperatorSentence(ExistsOperator, nodes[0].children[1], parent);

                expect(parent.scope).not.to.equal(child2.scope);
            })
        });
        it ("should have a property arity, equal to the operator's arity", function() {
            const {nodes} = toNode("(=> (A) (B))");
            const sentence = new OperatorSentence(ConditionalOperator, nodes[0]);
            expect(sentence.arity).to.equal(ConditionalOperator.arity);
        });
        it ("should have a childNodes property which returns the nodes AFTER the operator", function() {
            const {nodes} = toNode("(=> (A) (B))");
            const sentence = new OperatorSentence(ConditionalOperator, nodes[0]);
            expect(sentence.childNodes).to.have.length(2);
            expect(sentence.childNodes).to.have.members([nodes[0].children[1], nodes[0].children[2]])
        });
        describe("addTerm()", function() {
            it ("should push the term to terms", function() {
                const {nodes} = toNode("(or (A) (B))");
                const sentence = new OperatorSentence(OrOperator, nodes[0]);
                expect(sentence.terms).to.have.length(1);

                sentence.addTerm(nodes[0].children[1], new Sentence(nodes[0].children[1]));
                sentence.addTerm(nodes[0].children[2], new Sentence(nodes[0].children[2]));

                expect(sentence.terms).to.have.length(3);
            });

            it ("should error if the added term makes the number of terms exceed the arity", function() {
                const {nodes} = toNode("(=> (A) (B) (C))");
                const sentence = new OperatorSentence(ConditionalOperator, nodes[0]);
                expect(sentence.terms).to.have.length(1);
                expect(sentence.arity).to.equal(2);
                sentence.addTerm(nodes[0].children[1], new Sentence(nodes[0].children[1]));
                sentence.addTerm(nodes[0].children[2], new Sentence(nodes[0].children[2]));
                expect(() => {
                    sentence.addTerm(nodes[0].children[3], new Sentence(nodes[0].children[3]))
                }).to.throw("Addition of the term exceeds the arity of the sentence");

                expect(sentence.terms).to.have.length(3);
            });

            it ("should enforce that the first term be a sentence of variables", function() {
                const {nodes} = toNode("(exists (?A) (not ?A))");
                const sentence = new OperatorSentence(ExistsOperator, nodes[0]);
                expect(sentence.terms).to.have.length(1);
                const varList = new Sentence(nodes[0].children[1]);
                varList.terms = [ new VariableSym("?A") ];
                sentence.addTerm(nodes[0].children[1], varList);
                expect(sentence.terms).to.have.length(2);

                const badSentence = new OperatorSentence(ExistsOperator, nodes[0]);
                expect(badSentence.terms).to.have.length(1);
                const notVarList = new Sentence(nodes[0].children[1]);
                notVarList.terms = [ new Symbol("A", {}) ];
                expect(() => {
                    sentence.addTerm(nodes[0].children[1], notVarList);
                }, "Invalid first term, must be a sentence comprised only of variables");
            });
        });
    })
});
