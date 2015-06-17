/* jslint node: true */
'use strict';

var View			= require('./view.js').View;
var miscUtil		= require('./misc_util.js');
var strUtil			= require('./string_util.js');
var ansi			= require('./ansi_term.js');
//var TextBuffer		= require('./text_buffer.js').TextBuffer;

var assert			= require('assert');
var _				= require('lodash');

//	:TODO: Determine CTRL-* keys for various things
	//	See http://www.bbsdocumentary.com/library/PROGRAMS/GRAPHICS/ANSI/bansi.txt
	//	http://wiki.synchro.net/howto:editor:slyedit#edit_mode
	//	http://sublime-text-unofficial-documentation.readthedocs.org/en/latest/reference/keyboard_shortcuts_win.html

	/* Mystic
	 [^B]  Reformat Paragraph            [^O]  Show this help file
       [^I]  Insert tab space              [^Q]  Enter quote mode
       [^K]  Cut current line of text      [^V]  Toggle insert/overwrite
       [^U]  Paste previously cut text     [^Y]  Delete current line


                            BASIC MOVEMENT COMMANDS

                  UP/^E       LEFT/^S      PGUP/^R      HOME/^F
                DOWN/^X      RIGHT/^D      PGDN/^C       END/^G
*/

//
//	Some other interesting implementations, resources, etc.
//
//	Editors - BBS
//	*	https://github.com/M-griffin/Enthral/blob/master/src/msg_fse.cpp
//
//	Editors - Other
//	*	http://joe-editor.sourceforge.net/
//	* 	http://www.jbox.dk/downloads/edit.c
//

//
//	To-Do
//	
//	* Word wrap from pos to next { eol : true } when inserting text
//	* Page up/down just divide by and set top index
//	* Index pos % for emit scroll events
//	* 

var SPECIAL_KEY_MAP_DEFAULT = {
	lineFeed	: [ 'return' ],
	exit		: [ 'esc' ],
	backspace	: [ 'backspace' ],
	del			: [ 'del' ],
	tab			: [ 'tab' ],
	up			: [ 'up arrow' ],
	down		: [ 'down arrow' ],
	end			: [ 'end' ],
	home		: [ 'home' ],
	left		: [ 'left arrow' ],
	right		: [ 'right arrow' ],
	clearLine	: [ 'ctrl + y' ],
	pageUp		: [ 'page up' ],
	pageDown	: [ 'page down' ],
	insert		: [ 'insert', 'ctrl + v' ],
};

exports.MultiLineEditTextView2	= MultiLineEditTextView2;

function MultiLineEditTextView2(options) {
	if(!_.isBoolean(options.acceptsFocus)) {
		options.acceptsFocus = true;
	}

	if(!_.isBoolean(this.acceptsInput)) {
		options.acceptsInput = true;
	}

	if(!_.isObject(options.specialKeyMap)) {
		options.specialKeyMap = SPECIAL_KEY_MAP_DEFAULT;
	}

	View.call(this, options);

	var self = this;

	//
	//	ANSI seems to want tabs to default to 8 characters. See the following:
	//	* http://www.ansi-bbs.org/ansi-bbs2/control_chars/
	//	* http://www.bbsdocumentary.com/library/PROGRAMS/GRAPHICS/ANSI/bansi.txt
	//
	//	This seems overkill though, so let's default to 4 :)
	//
	this.tabWidth	= _.isNumber(options.tabWidth) ? options.tabWidth : 4;

	this.textLines			= [];
	this.topVisibleIndex	= 0;

	//
	//	cursorPos represents zero-based row, col positions
	//	within the editor itself
	//
	this.cursorPos			= { col : 0, row : 0 };

	this.getSGRFor = function(sgrFor) {
		return {
			text : self.getSGR(),
		}[sgrFor] || self.getSGR();
	};

	//	:TODO: Most of the calls to this could be avoided via incrementRow(), decrementRow() that keeps track or such
	this.getTextLinesIndex = function(row) {
		if(!_.isNumber(row)) {
			row = self.cursorPos.row;
		}
		var index = self.topVisibleIndex + row;
		return index;
	};

	this.getRemainingLinesBelowRow = function(row) {
		if(!_.isNumber(row)) {
			row = self.cursorPos.row;
		}
		return self.textLines.length - (self.topVisibleIndex + row) - 1;
	};

	this.getNextEndOfLineIndex = function(startIndex) {
		for(var i = startIndex; i < self.textLines.length; i++) {
			if(self.textLines[i].eol) {
				return i;
			}
		}
		return self.textLines.length;
	};

	this.redrawRows = function(startRow, endRow) {
		self.client.term.write(self.getSGRFor('text') + ansi.hideCursor());

		var startIndex	= self.getTextLinesIndex(startRow);
		var endIndex	= Math.min(self.getTextLinesIndex(endRow), self.textLines.length);
		var absPos		= self.getAbsolutePosition(startRow, 0);

		for(var i = startIndex; i < endIndex; ++i) {
			self.client.term.write(ansi.goto(absPos.row++, absPos.col));
			self.client.term.write(self.getRenderText(i));
		}

		self.client.term.write(ansi.showCursor());
	};

	this.redrawVisibleArea = function() {
		assert(self.topVisibleIndex <= self.textLines.length);
		self.redrawRows(0, self.dimens.height);
	};

	this.getVisibleText = function(index) {
		if(!_.isNumber(index)) {
			index = self.getTextLinesIndex();
		}
		return self.textLines[index].text.replace(/\t/g, ' ');	
	};

	this.getText = function(index) {
		if(!_.isNumber(index)) {
			index = self.getTextLinesIndex();
		}
		return self.textLines[index].text;
	};

	this.getCharacter = function(index, col) {
		if(!_.isNumber(col)) {
			col = self.cursorPos.col;
		}
		return self.getText(index).charAt(col);
	};

	this.getTextEndOfLineColumn = function(index) {
		return Math.max(0, self.getText(index).length);
	};

	this.getRenderText = function(index) {
		var text = self.getVisibleText(index);
		var remain	= self.dimens.width - text.length;
		if(remain > 0) {
			text += new Array(remain).join(' ');
		}
		return text;
	};

 	this.getTextLines = function(startIndex, endIndex) {
 		var lines;
		if(startIndex === endIndex) {
			lines = [ self.textLines[startIndex] ];
		} else {
			lines = self.textLines.slice(startIndex, endIndex + 1);	//	"slice extracts up to but not including end."
		}
		return lines;
 	};

	this.getOutputText = function(startIndex, endIndex, includeEol) {
		var lines = self.getTextLines(startIndex, endIndex);

		//
		//	Convert lines to contiguous string -- all expanded
		//	tabs put back to single '\t' characters.
		//
		var text = '';
		var re = new RegExp('\\t{1,' + (self.tabWidth) + '}', 'g');
		for(var i = 0; i < lines.length; ++i) {
			text += lines[i].text.replace(re, '\t');
			if(includeEol && lines[i].eol) {
				text += '\n';
			}
		}
		return text;
	};

	this.getContiguousText = function(startIndex, endIndex, includeEol) {
		var lines = self.getTextLines(startIndex, endIndex);
		var text = '';
		for(var i = 0; i < lines.length; ++i) {
			text += lines[i].text;
			if(includeEol && lines[i].eol) {
				text += '\n';
			}
		}
		return text;
	};

	this.replaceCharacterInText = function(c, index, col) {
		self.textLines[index].text = strUtil.replaceAt(
			self.textLines[index].text, col, c);
	};

	/*
	this.editTextAtPosition = function(editAction, text, index, col) {
		switch(editAction) {
			case 'insert' : 
				self.insertCharactersInText(text, index, col);
				break;

			case 'deleteForward' :
				break;

			case 'deleteBack' :
				break;

			case 'replace' :
				break;
		}
	};
	*/

	this.updateTextWordWrap = function(index) {
		var nextEolIndex	= self.getNextEndOfLineIndex(index);
		var wrapped			= self.wordWrapSingleLine(self.getContiguousText(index, nextEolIndex), 'tabsIntact');
		var newLines		= wrapped.wrapped;

		for(var i = 0; i < newLines.length; ++i) {
			newLines[i] = { text : newLines[i] };
		}
		newLines[newLines.length - 1].eol = true;

		Array.prototype.splice.apply(
			self.textLines, 
			[ index, (nextEolIndex - index) + 1 ].concat(newLines));

		return wrapped.firstWrapRange;
	};

	this.removeCharactersFromText = function(index, col, direction, count) {
		var text = self.getText();

		if('right' === direction) {
			/*self.textLines[startIndex].text = 
				self.textLines[startIndex].text.slice(col, count) +
				self.textLines[startIndex].text.slice(col + count);
			*/
			text = text.slice(col, count) + text.slice(col + count);

			if(0 === text.length) {

			} else {
				self.redrawRows(self.cursorPos.row, self.dimens.height);
			}
		} else if ('left' === direction) {
			self.textLines[index].text =
				self.textLines[index].text.slice(0, col - count) + 
				self.textLines[index].text.slice(col + 1);

			self.cursorPos.col -= count;

			self.updateTextWordWrap(index);

			self.redrawRows(self.cursorPos.row, self.dimens.height);

			if(0 === self.cursorPos.col) {

			} else {
				var absPos = self.getAbsolutePosition(self.cursorPos.row, self.cursorPos.col);
				self.client.term.write(ansi.goto(absPos.row, absPos.col));
			}

			
		}
	};

	this.insertCharactersInText = function(c, index, col) {
		self.textLines[index].text = [
				self.textLines[index].text.slice(0, col), 
				c, 
				self.textLines[index].text.slice(col)				
			].join('');

		//self.cursorPos.col++;
		self.cursorPos.col += c.length;

		var cursorOffset;
		var absPos;

		if(self.getText(index).length >= self.dimens.width) {
			//
			//	Past available space -- word wrap from current point
			//	to the next EOL. Update textLines with the newly
			//	formatted array.
			//
			/*
			var nextEolIndex	= self.getNextEndOfLineIndex(index);
			var wrapped			= self.wordWrapSingleLine(self.getContiguousText(index, nextEolIndex), 'tabsIntact');
			var newLines		= wrapped.wrapped;

			//
			//	If our cursor was within the bounds of the last wrapped word
			//	we'll want to adjust the cursor to the same relative position
			//	on the next line.
			//
			//var lastCol = self.cursorPos.col - 1;
			var lastCol = self.cursorPos.col - c.length;
			if(lastCol >= wrapped.firstWrapRange.start && lastCol <= wrapped.firstWrapRange.end) {
				cursorOffset = self.cursorPos.col - wrapped.firstWrapRange.start;
			}

			for(var i = 0; i < newLines.length; ++i) {
				newLines[i] = { text : newLines[i] };
			}
			newLines[newLines.length - 1].eol = true;

			Array.prototype.splice.apply(
				self.textLines, 
				[ index, (nextEolIndex - index) + 1 ].concat(newLines));
			*/

			//
			//	Update word wrapping and |cursorOffset| if the cursor
			//	was within the bounds of the wrapped text
			//
			var lastCol			= self.cursorPos.col - c.length;
			var firstWrapRange	= self.updateTextWordWrap(index);
			if(lastCol >= firstWrapRange.start && lastCol <= firstWrapRange.end) {
				cursorOffset = self.cursorPos.col - firstWrapRange.start;
			}

			//	redraw from current row to end of visible area
			self.redrawRows(self.cursorPos.row, self.dimens.height);

			if(!_.isUndefined(cursorOffset)) {
				console.log('cursorOffset=' + cursorOffset)
				self.cursorBeginOfNextLine();
				self.cursorPos.col += cursorOffset;
				self.client.term.write(ansi.right(cursorOffset));
			} else {
				absPos = self.getAbsolutePosition(self.cursorPos.row, self.cursorPos.col);
				console.log('absPos=' + JSON.stringify(absPos))
				self.client.term.write(ansi.goto(absPos.row, absPos.col));
			}
		} else {
			//
			//	We must only redraw from col -> end of current visible line
			//
			absPos = self.getAbsolutePosition(self.cursorPos.row, self.cursorPos.col);
			self.client.term.write(
				ansi.hideCursor() + 
				self.getSGRFor('text') +  
				self.getRenderText(index).slice(self.cursorPos.col - c.length) +
				ansi.goto(absPos.row, absPos.col) +
				ansi.showCursor()
				);
		}			
	};

	this.getRemainingTabWidth = function(col) {
		if(!_.isNumber(col)) {
			col = self.cursorPos.col;
		}
		return self.tabWidth - (col % self.tabWidth);
	};

	this.calculateTabStops = function() {
		self.tabStops = [ 0 ];
		var col = 0;
		while(col < self.dimens.width) {
			col += self.getRemainingTabWidth(col);
			self.tabStops.push(col);
		}
	};

	this.getNextTabStop = function(col) {
		var i = self.tabStops.length;
		while(self.tabStops[--i] > col);
		return self.tabStops[++i];
	};

	this.getPrevTabStop = function(col) {
		var i = self.tabStops.length;
		while(self.tabStops[--i] >= col);
		return self.tabStops[i];
	};

	this.expandTab = function(col, expandChar) {
		expandChar = expandChar || ' ';
		return new Array(self.getRemainingTabWidth(col)).join(expandChar);
	};

	this.wordWrapSingleLine = function(s, tabHandling, width) {
		tabHandling = tabHandling || 'expandTabs';
		if(!_.isNumber(width)) {
			width = self.dimens.width;
		}

		//
		//	Notes
		//	*	Sublime Text 3 for example considers spaces after a word
		//		part of said word. For example, "word    " would be wraped
		//		in it's entirity.
		//
		//	*	Tabs in Sublime Text 3 are also treated as a word, so, e.g.
		//		"\t" may resolve to "      " and must fit within the space.
		//
		//	*	If a word is ultimately too long to fit, break it up until it does.
		//
		//	RegExp below is JavaScript '\s' minus the '\t'
		//
		var re = new RegExp(
			'\t|[ \f\n\r\v​\u00a0\u1680​\u180e\u2000​\u2001\u2002​\u2003\u2004\u2005\u2006​' + 
			'\u2007\u2008​\u2009\u200a​\u2028\u2029​\u202f\u205f​\u3000]', 'g');
		var m;
		var wordStart = 0;
		var results = { wrapped : [ '' ] };
		var i = 0;
		var word;

		function addWord() {
			word.match(new RegExp('.{0,' + width + '}', 'g')).forEach(function wrd(w) {
				if(results.wrapped[i].length + w.length >= width) {
					if(0 === i) {
						results.firstWrapRange = { start : wordStart, end : wordStart + w.length };
					}
					results.wrapped[++i] = w;
				} else {
					results.wrapped[i] += w;
				}
			});
		}

		while((m = re.exec(s)) !== null) {
			word	= s.substring(wordStart, re.lastIndex - 1);

			switch(m[0].charAt(0)) {
				case ' ' :
					word += m[0];
				break;

				case '\t' :
					//
					//	Expand tab given position
					//
					//	Nice info here: http://c-for-dummies.com/blog/?p=424
					//
					if('expandTabs' === tabHandling) {
						word += self.expandTab(results.wrapped[i].length + word.length, '\t') + '\t';
					} else {
						word += m[0];
					}
				break;
			}

			addWord();
			wordStart = re.lastIndex + m[0].length - 1;
		}

		//
		//	Remainder
		//
		word = s.substring(wordStart);
		addWord();

		return results;
	};

	//	:TODO: rename to insertRawText()
	this.insertRawText = function(text, index, col) {
		//
		//	Perform the following on |text|:
		//	*	Normalize various line feed formats -> \n
		//	*	Remove some control characters (e.g. \b)
		//	*	Word wrap lines such that they fit in the visible workspace.
		//		Each actual line will then take 1:n elements in textLines[].
		//	*	Each tab will be appropriately expanded and take 1:n \t
		//		characters. This allows us to know when we're in tab space
		//		when doing cursor movement/etc.
		//
		//
		//	Try to handle any possible newline that can be fed to us.
		//	See http://stackoverflow.com/questions/5034781/js-regex-to-split-by-line
		//
		//	:TODO: support index/col insertion point

		if(_.isNumber(index)) {
			if(_.isNumber(col)) {
				//
				//	Modify text to have information from index
				//	before and and after column
				//
				//	:TODO: Need to clean this string (e.g. collapse tabs)
				text = self.textLines

				//	:TODO: Remove original line @ index
			}
		} else {
			index = self.textLines.length;
		}

		text = text
			.replace(/\b/g, '')
			.split(/\r\n|[\n\v\f\r\x85\u2028\u2029]/g);

		var wrapped;
		
		for(var i = 0; i < text.length; ++i) {
			wrapped = self.wordWrapSingleLine(text[i], 'expandTabs', self.dimens.width).wrapped;

			for(var j = 0; j < wrapped.length - 1; ++j) {
				self.textLines.splice(index++, 0, { text : wrapped[j] } );
			}
			self.textLines.splice(index++, 0, { text : wrapped[wrapped.length - 1], eol : true });
		}
	};

	this.getAbsolutePosition = function(row, col) {
		return { 
			row : self.position.row + row,
			col : self.position.col + col,
		};
	};

	this.moveClientCusorToCursorPos = function() {
		var absPos = self.getAbsolutePosition(self.cursorPos.row, self.cursorPos.col);
		self.client.term.write(ansi.goto(absPos.row, absPos.col));
	};


	this.keyPressCharacter = function(c) {
		var index		= self.getTextLinesIndex();

		//
		//	:TODO: stuff that needs to happen
		//	* Break up into smaller methods
		//	* Even in overtype mode, word wrapping must apply if past bounds
		//	* A lot of this can be used for backspacing also
		//	* See how Sublime treats tabs in *non* overtype mode... just overwrite them?
		//
		//

		if(self.overtypeMode) {
			//	:TODO: special handing for insert over eol mark?
			self.replaceCharacterInText(c, index, self.cursorPos.col);
			self.cursorPos.col++;
			self.client.term.write(c);
		} else {
			self.insertCharactersInText(c, index, self.cursorPos.col);

			/*if(self.cursorPos.col >= self.dimens.width) {
				console.log('next line')
				self.cursorBeginOfNextLine();
				//self.client.term.write(ansi.right(cursorOffset))
			}*/
		}

	};

	this.keyPressUp = function() {
		if(self.cursorPos.row > 0) {
			self.cursorPos.row--;
			self.client.term.write(ansi.up());

			if(!self.adjustCursorToNextTab('up')) {
				self.adjustCursorIfPastEndOfLine(false);
			}
		} else {
			self.scrollDocumentDown();
			self.adjustCursorIfPastEndOfLine(true);
		}
	};

	this.keyPressDown = function() {
		var lastVisibleRow = Math.min(self.dimens.height, self.textLines.length) - 1;
		if(self.cursorPos.row < lastVisibleRow) {
			self.cursorPos.row++;
			self.client.term.write(ansi.down());

			if(!self.adjustCursorToNextTab('down')) {
				self.adjustCursorIfPastEndOfLine(false);
			}
		} else {
			self.scrollDocumentUp();
			self.adjustCursorIfPastEndOfLine(true);
		}
	};

	this.keyPressLeft = function() {
		if(self.cursorPos.col > 0) {
			var prevChar = self.getCharacter();

			self.cursorPos.col--;
			self.client.term.write(ansi.left());

			if('\t' === prevChar) {
				self.adjustCursorToNextTab('left');
			}
		} else {
			self.cursorEndOfPreviousLine();
		}
	};

	this.keyPressRight = function() {
		var eolColumn = self.getTextEndOfLineColumn();
		if(self.cursorPos.col < eolColumn) {
			var prevChar = self.getCharacter();

			self.cursorPos.col++;
			self.client.term.write(ansi.right());

			if('\t' === prevChar) {
				self.adjustCursorToNextTab('right');
			}
		} else {
			self.cursorBeginOfNextLine();
		}
	};

	this.keyPressHome = function() {
		var firstNonWhitespace = self.getVisibleText().search(/\S/);
		if(-1 !== firstNonWhitespace) {
			self.cursorPos.col = firstNonWhitespace;
		} else {
			self.cursorPos.col = 0;
		}
		console.log('"' + self.getVisibleText() + '"')
		self.moveClientCusorToCursorPos();
	};

	this.keyPressEnd = function() {
		self.cursorPos.col = self.getTextEndOfLineColumn();
		self.moveClientCusorToCursorPos();
	};

	this.keyPressPageUp = function() {

	};

	this.keyPressPageDown = function() {

	};

	this.keyPressLineFeed = function() {
		//
		//	Break up text from cursor position, redraw, and update cursor
		//	position to start of next line
		//
		var index			= self.getTextLinesIndex();
		var nextEolIndex	= self.getNextEndOfLineIndex(index);
		var text			= self.getContiguousText(index, nextEolIndex);
		var newLines		= self.wordWrapSingleLine(text.slice(self.cursorPos.col), 'tabsIntact').wrapped;
		
		newLines.unshift( { text : text.slice(0, self.cursorPos.col), eol : true } );
		for(var i = 1; i < newLines.length; ++i) {
			newLines[i] = { text : newLines[i] };
		}
		newLines[newLines.length - 1].eol = true;

		Array.prototype.splice.apply(
			self.textLines, 
			[ index, (nextEolIndex - index) + 1 ].concat(newLines));

		//	redraw from current row to end of visible area
		self.redrawRows(self.cursorPos.row, self.dimens.height);
		self.cursorBeginOfNextLine();
	};

	this.keyPressInsert = function() {
		//	:TODO: emit event
		self.overtypeMode = !self.overtypeMode;
	};

	this.keyPressTab = function() {
		var index = self.getTextLinesIndex();
		self.insertCharactersInText(self.expandTab(self.cursorPos.col, '\t') + '\t', index, self.cursorPos.col);
	};

	this.keyPressBackspace = function() {
		if(self.cursorPos.col > 1) {
			//
			//	Don't want to delete character at cursor, but rather the character
			//	to the left of the cursor!
			//
			self.cursorPos.col -= 1;

			var index = self.getTextLinesIndex();
			var count;

			if('\t' === self.getCharacter(index, self.cursorPos.col)) {
				//	:TODO: This isn't right... need to find how many up to count to actually remove
				count = (self.cursorPos.col - self.getPrevTabStop(self.cursorPos.col));
			} else {
				count = 1;
			}

			self.removeCharactersFromText(
				index,
				self.cursorPos.col,
				'left',
				count);
		}
	};

	this.keyPressDel = function() {
		self.removeCharactersFromText(
			self.getTextLinesIndex(),
			self.cursorPos.col,
			'right',
			1);
	};

	this.adjustCursorIfPastEndOfLine = function(forceUpdate) {
		var eolColumn = self.getTextEndOfLineColumn();
		if(self.cursorPos.col > eolColumn) {
			self.cursorPos.col = eolColumn;
			forceUpdate = true;
		}

		if(forceUpdate) {
			self.moveClientCusorToCursorPos();
		}
	};

	this.adjustCursorToNextTab = function(direction) {
		if('\t' === self.getCharacter()) {
			var move;
			switch(direction) {
				//
				//	Next tabstop to the right
				//
				case 'right' :
					move = self.getNextTabStop(self.cursorPos.col) - self.cursorPos.col;
					self.cursorPos.col += move;
					self.client.term.write(ansi.right(move));
					break;

				//
				//	Next tabstop to the left
				//
				case 'left' :
					move = self.cursorPos.col - self.getPrevTabStop(self.cursorPos.col);
					self.cursorPos.col -= move;
					self.client.term.write(ansi.left(move));
					break;

				case 'up' : 
				case 'down' :
					//	
					//	Jump to the tabstop nearest the cursor
					//
					var newCol = self.tabStops.reduce(function r(prev, curr) {
						return (Math.abs(curr - self.cursorPos.col) < Math.abs(prev - self.cursorPos.col) ? curr : prev);
					});

					if(newCol > self.cursorPos.col) {
						move = newCol - self.cursorPos.col;
						self.cursorPos.col += move;
						self.client.term.write(ansi.right(move));
					} else if(newCol < self.cursorPos.col) {
						move = self.cursorPos.col - newCol;
						self.cursorPos.col -= move;
						self.client.term.write(ansi.left(move));
					}
					break;
			}

			return true;
		}
		return false;	//	did not fall on a tab
	};

	this.cursorStartOfDocument = function() {
		self.topVisibleIndex	= 0;
		self.cursorPos			= { row : 0, col : 0 };

		self.redraw();
		self.moveClientCusorToCursorPos();
	};

	this.cursorEndOfDocument = function() {
		self.topVisibleIndex	= Math.max(self.textLines.length - self.dimens.height, 0);
		self.cursorPos.row		= (self.textLines.length - self.topVisibleIndex) - 1;
		self.cursorPos.col		= self.getTextEndOfLineColumn();

		self.redraw();
		self.moveClientCusorToCursorPos();
	};

	this.cursorBeginOfNextLine = function() {
		//	e.g. when scrolling right past eol
		var linesBelow = self.getRemainingLinesBelowRow();
	
		if(linesBelow > 0) {
			var lastVisibleRow	= Math.min(self.dimens.height, self.textLines.length) - 1;
			if(self.cursorPos.row < lastVisibleRow) {
				self.cursorPos.row++;
			} else {
				self.scrollDocumentUp();
			}
			self.keyPressHome();	//	same as pressing 'home'
		}
	};

	this.cursorEndOfPreviousLine = function() {
		//	e.g. when scrolling left past start of line
		var moveToEnd;
		if(self.cursorPos.row > 0) {
			self.cursorPos.row--;
			moveToEnd = true;
		} else if(self.topVisibleIndex > 0) {
			self.scrollDocumentDown();
			moveToEnd = true;
		}

		if(moveToEnd) {
			self.keyPressEnd();	//	same as pressing 'end'
		}
	};

	/*
	this.cusorEndOfNextLine = function() {
		var linesBelow = self.getRemainingLinesBelowRow();

		if(linesBelow > 0) {
			var lastVisibleRow = Math.min(self.dimens.height, self.textLines.length) - 1;
			if(self.cursorPos.row < lastVisibleRow) {
				self.cursorPos.row++;
			} else {
				self.scrollDocumentUp();
			}
			self.keyPressEnd();	//	same as pressing 'end'
		}
	};
	*/

	this.scrollDocumentUp = function() {
		//
		//	Note: We scroll *up* when the cursor goes *down* beyond
		//	the visible area!
		//
		var linesBelow = self.getRemainingLinesBelowRow();
		if(linesBelow > 0) {
			self.topVisibleIndex++;
			self.redraw();
		}
	};

	this.scrollDocumentDown = function() {
		//
		//	Note: We scroll *down* when the cursor goes *up* beyond
		//	the visible area!
		//
		if(self.topVisibleIndex > 0) {
			self.topVisibleIndex--;
			self.redraw();
		}
	};

}

require('util').inherits(MultiLineEditTextView2, View);

MultiLineEditTextView2.prototype.setWidth = function(width) {
	MultiLineEditTextView2.super_.prototype.setWidth.call(this, width);

	this.calculateTabStops();
};

MultiLineEditTextView2.prototype.redraw = function() {
	MultiLineEditTextView2.super_.prototype.redraw.call(this);

	this.redrawVisibleArea();
};

MultiLineEditTextView2.prototype.setFocus = function(focused) {
	this.client.term.write(this.getSGRFor('text'));

	MultiLineEditTextView2.super_.prototype.setFocus.call(this, focused);
};

MultiLineEditTextView2.prototype.setText = function(text) {
	this.textLines = [ ];
	//text = "Tab:\r\n\tA\tB\tC\tD\tE\tF\tG\r\n reeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeally long word!!!";
	text = require('fs').readFileSync('/home/nuskooler/Downloads/test_text.txt', { encoding : 'utf-8'});

	this.insertRawText(text);//, 0, 0);
	this.cursorEndOfDocument();
	console.log(this.textLines)


};

var HANDLED_SPECIAL_KEYS = [
	'up', 'down', 'left', 'right', 
	'home', 'end',
	'pageUp', 'pageDown',
	'lineFeed',
	'insert',
	'tab',
	'backspace', 'del',
];

MultiLineEditTextView2.prototype.onKeyPress = function(ch, key) {
	var self = this;
	var handled;

	if(key) {		
		HANDLED_SPECIAL_KEYS.forEach(function aKey(specialKey) {
			if(self.isSpecialKeyMapped(specialKey, key.name)) {
				self[_.camelCase('keyPress ' + specialKey)]();
				handled = true;
			}
		});
	}

	if(ch && strUtil.isPrintable(ch)) {
		this.keyPressCharacter(ch);
	}

	if(!handled) {
		MultiLineEditTextView2.super_.prototype.onKeyPress.call(this, ch, key);
	}
};
