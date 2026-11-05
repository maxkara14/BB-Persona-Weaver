// IDs address immutable paragraphs within the analysis snapshot, not live chat.
export function sourceParagraphs(source) {
    return source.text.split(/\r?\n(?:[^\S\r\n]*\r?\n)+/u).filter(text => text.trim())
        .map((text, index) => ({ sourceId: `${source.id}:${index + 1}`, text }));
}

export function evidenceSources(sources) {
    return new Map(sources.flatMap(source => sourceParagraphs(source).map(paragraph => [paragraph.sourceId,
        { messageId: source.id, sourceId: paragraph.sourceId, quote: paragraph.text, author: source.author }])));
}
