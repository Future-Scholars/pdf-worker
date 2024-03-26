const { LocalPdfManager } = require("../pdf.js/build/lib/core/pdf_manager");
const { XRefParseException } = require("../pdf.js/build/lib/core/core_utils");

async function getPageData(
	pdfDocument,
	cmapProvider,
	standardFontProvider,
	data = {},
) {
	let handler = {};
	handler.send = function () {};
	handler.sendWithPromise = async function (op, data) {
		if (op === "FetchBuiltInCMap") {
			return cmapProvider(data.name);
		} else if (op === "FetchStandardFontData") {
			return standardFontProvider(data.filename);
		}
	};
	let task = { ensureNotTerminated() {} };
	return pdfDocument.getPageData({ handler, task, data });
}

async function getPdfManager(arrayBuffer, recoveryMode) {
	const pdfManagerArgs = {
		source: arrayBuffer,
		evaluatorOptions: {
			cMapUrl: null,
			standardFontDataUrl: null,
			ignoreErrors: true,
		},
		password: ""
	};
	let pdfManager = new LocalPdfManager(pdfManagerArgs);
	await pdfManager.ensureDoc("checkHeader", []);
	await pdfManager.ensureDoc("parseStartXRef", []);
	// Enter into recovery mode if the initial parse fails
	try {
		await pdfManager.ensureDoc("parse", [recoveryMode]);
	} catch (e) {
		if (!(e instanceof XRefParseException) && !recoveryMode) {
			throw e;
		}
		recoveryMode = true;
		await pdfManager.ensureDoc("parse", [recoveryMode]);
	}
	await pdfManager.ensureDoc("numPages");
	await pdfManager.ensureDoc("fingerprint");
	return pdfManager;
}

async function getFulltext(
	buf,
	password,
	pagesNum,
	cmapProvider,
	standardFontProvider,
) {
	let pdfManager = await getPdfManager(buf);
	let actualCount = pdfManager.pdfDocument.numPages;
	if (!Number.isInteger(pagesNum) || pagesNum > actualCount) {
		pagesNum = actualCount;
	}
	let text = [];
	let pageIndex = 0;
	for (; pageIndex < pagesNum; pageIndex++) {
		let { structuredText } = await getPageData(
			pdfManager.pdfDocument,
			cmapProvider,
			standardFontProvider,
			{ pageIndex },
		);
		let { paragraphs } = structuredText;
		for (let paragraph of paragraphs) {
			for (let line of paragraph.lines) {
				for (let word of line.words) {
					for (let char of word.chars) {
						text.push(char.c);
					}
					if (word.spaceAfter) {
						text.push(" ");
					}
				}
				if (line !== paragraph.lines.at(-1)) {
					if (line.hyphenated) {
						text.pop();
					} else {
						text.push(" ");
					}
				}
			}
			if (paragraph !== paragraphs.at(-1)) {
				text.push("\n");
			}
		}
		text.push("\n\n");
		if (pageIndex !== pagesNum - 1) {
			text.push("\f");
		}
	}
	text = text.join("");
	return {
		text,
		extractedPages: pageIndex,
		totalPages: actualCount,
	};
}

async function getRecognizerData(
	buf,
	password,
	cmapProvider,
	standardFontProvider,
) {
	let round = (n) => Math.round(n * 10000) / 10000;

	let pdfManager = await getPdfManager(buf);

	let totalPages = pdfManager.pdfDocument.numPages;

	let maxPages = 5;
	if (!Number.isInteger(maxPages) || maxPages > totalPages) {
		maxPages = totalPages;
	}

	let metadata = {};
	for (let key in pdfManager.pdfDocument.documentInfo) {
		if (key === "PDFFormatVersion") {
			continue;
		}
		let value = pdfManager.pdfDocument.documentInfo[key];
		if (typeof value === "string") {
			metadata[key] = value;
		} else if (typeof value === "object" && key === "Custom") {
			for (let key2 in value) {
				let value2 = value[key2];
				if (typeof value2 === "string") {
					metadata[key2] = value2;
				}
			}
		}
	}

	let data = { metadata, totalPages, pages: [] };
	let pageIndex = 0;
	for (; pageIndex < maxPages; pageIndex++) {
		let page = await pdfManager.pdfDocument.getPage(pageIndex);
		let pageWidth = page.view[2];
		let pageHeight = page.view[3];

		let fonts = [];

		let pageData = await getPageData(
			pdfManager.pdfDocument,
			cmapProvider,
			standardFontProvider,
			{ pageIndex },
		);
		let { paragraphs } = pageData.structuredText;

		let newLines = [];

		for (let paragraph of paragraphs) {
			for (let line of paragraph.lines) {
				let newLine = [];
				for (let word of line.words) {
					let [xMin, yMin, xMax, yMax] = word.rect;
					xMin = round(word.rect[0]);
					xMax = round(word.rect[2]);
					yMin = round(pageHeight - word.rect[3]);
					yMax = round(pageHeight - word.rect[1]);

					let char = word.chars[0];

					let fontIndex = fonts.indexOf(char.fontName);
					if (fontIndex === -1) {
						fonts.push(char.fontName);
						fontIndex = fonts.length - 1;
					}

					let fontSize = round(char.fontSize);
					let spaceAfter = word.spaceAfter ? 1 : 0;
					let baseline = round(
						char.rotation === 0
							? round(pageHeight - char.baseline)
							: char.baseline,
					);
					let rotation = 0;
					let underlined = 0;
					let bold = char.bold ? 1 : 0;
					let italic = char.italic ? 1 : 0;
					let colorIndex = 0;
					let text = word.chars.map((x) => x.u).join("");

					newLine.push([
						xMin,
						yMin,
						xMax,
						yMax,
						fontSize,
						spaceAfter,
						baseline,
						rotation,
						underlined,
						bold,
						italic,
						colorIndex,
						fontIndex,
						text,
					]);
				}
				if (newLine.length) {
					newLines.push([newLine]);
				}
			}
		}

		data.pages.push([pageWidth, pageHeight, [[[[0, 0, 0, 0, newLines]]]]]);
	}
	return data;
}

function errObject(err) {
	return JSON.parse(JSON.stringify(err, Object.getOwnPropertyNames(err)));
}

let cmapCache = {};
async function cmapProvider(name) {
	if (cmapCache[name]) {
		return cmapCache[name];
	}
	let data = await query("FetchBuiltInCMap", name);
	cmapCache[name] = data;
	return data;
}

let fontCache = {};
async function standardFontProvider(filename) {
	if (fontCache[filename]) {
		return fontCache[filename];
	}
	let data = await query("FetchStandardFontData", filename);
	fontCache[filename] = data;
	return data;
}

if (typeof self !== "undefined") {
	let promiseID = 0;
	let waitingPromises = {};

	self.query = async function (action, data) {
		return new Promise(function (resolve) {
			promiseID++;
			waitingPromises[promiseID] = resolve;
			self.postMessage({ id: promiseID, action, data });
		});
	};

	self.onmessage = async function (e) {
		let message = e.data;

		if (message.responseID) {
			let resolve = waitingPromises[message.responseID];
			if (resolve) {
				resolve(message.data);
			}
			return;
		}

		if (message.action === "getFulltext") {
			try {
				let data = await getFulltext(
					message.data.buf,
					message.data.password,
					message.data.maxPages,
					cmapProvider,
					standardFontProvider,
				);
				self.postMessage({ responseID: message.id, data }, []);
			} catch (e) {
				self.postMessage(
					{
						responseID: message.id,
						error: errObject(e),
					},
					[],
				);
			}
		} else if (message.action === "getRecognizerData") {
			try {
				let data = await getRecognizerData(
					message.data.buf,
					message.data.password,
					cmapProvider,
					standardFontProvider,
				);
				self.postMessage({ responseID: message.id, data }, []);
			} catch (e) {
				self.postMessage(
					{
						responseID: message.id,
						error: errObject(e),
					},
					[],
				);
			}
		}
	};
}

module.exports = {
	getFulltext,
	getRecognizerData,
};
