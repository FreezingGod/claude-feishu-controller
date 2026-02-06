/**
 * 飞书富文本 (post) 转换器
 * 将 Markdown 转换为飞书 post 类型的富文本格式
 * 支持标题、代码块、列表、粗体、斜体等
 */

/**
 * 将 Markdown 转换为飞书富文本格式
 * @param {string} markdown - Markdown 文本
 * @param {Object} options - 转换选项
 * @returns {Object} - 飞书富文本 content 对象
 */
export function markdownToFeishuRichText(markdown, options = {}) {
  const { maxCodeBlockLength = 3000 } = options;

  if (!markdown || typeof markdown !== 'string') {
    return { post: { zh_cn: [[{ tag: 'text', text: '' }]] } };
  }

  // 解析 Markdown 为段落
  const paragraphs = parseMarkdown(markdown, maxCodeBlockLength);

  // 转换为飞书富文本格式
  // 飞书 post 类型格式：{ post: { zh_cn: { content: [[...]] } } }
  const content = {
    post: {
      zh_cn: {
        content: paragraphs.map(para => convertParagraph(para))
      }
    }
  };

  return content;
}

/**
 * 解析 Markdown 为结构化段落
 * @param {string} markdown - Markdown 文本
 * @param {number} maxCodeBlockLength - 代码块最大长度
 * @returns {Array} - 段落数组
 */
function parseMarkdown(markdown, maxCodeBlockLength) {
  const paragraphs = [];
  const lines = markdown.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // 空行 - 分隔段落
    if (!trimmed) {
      i++;
      continue;
    }

    // 代码块
    if (trimmed.startsWith('```')) {
      const result = parseCodeBlock(lines, i, maxCodeBlockLength);
      paragraphs.push(result.para);
      i = result.nextIndex;
      continue;
    }

    // 标题
    if (trimmed.startsWith('#')) {
      const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        paragraphs.push({
          type: 'heading',
          level: headingMatch[1].length,
          text: headingMatch[2]
        });
        i++;
        continue;
      }
    }

    // 列表
    if (trimmed.startsWith('-') || trimmed.startsWith('*')) {
      const result = parseList(lines, i);
      paragraphs.push(...result.paragraphs);
      i = result.nextIndex;
      continue;
    }

    // 有序列表
    const orderedMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (orderedMatch) {
      const result = parseList(lines, i);
      paragraphs.push(...result.paragraphs);
      i = result.nextIndex;
      continue;
    }

    // 引用
    if (trimmed.startsWith('>')) {
      const result = parseBlockquote(lines, i);
      paragraphs.push(result.para);
      i = result.nextIndex;
      continue;
    }

    // 普通段落（可能包含多行）
    const result = parseParagraph(lines, i);
    paragraphs.push(result.para);
    i = result.nextIndex;
  }

  return paragraphs;
}

/**
 * 解析代码块
 */
function parseCodeBlock(lines, startIndex, maxLength) {
  const firstLine = lines[startIndex];
  const langMatch = firstLine.match(/^```(\w*)/);
  const lang = langMatch ? langMatch[1] : '';

  let code = '';
  let i = startIndex + 1;

  while (i < lines.length && !lines[i].trim().startsWith('```')) {
    code += lines[i] + '\n';
    i++;
  }

  // 截断过长代码
  if (code.length > maxLength) {
    code = code.slice(0, maxLength) + '\n// ... (代码过长，已截断)';
  }

  return {
    para: {
      type: 'code',
      language: lang || 'plaintext',
      text: code.trim()
    },
    nextIndex: i + 1 // 跳过结束的 ```
  };
}

/**
 * 解析列表
 */
function parseList(lines, startIndex) {
  const paragraphs = [];
  const items = [];
  let i = startIndex;
  let isOrdered = false;

  // 检查列表类型
  const firstMatch = lines[startIndex].trim().match(/^[\-\*]\s+/);
  const orderedMatch = lines[startIndex].trim().match(/^\d+\.\s+/);
  isOrdered = !!orderedMatch;

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    // 空行结束列表
    if (!trimmed) break;

    // 检查是否是列表项
    const itemMatch = trimmed.match(/^[\-\*]\s+(.+)$/);
    const orderedItemMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);

    if (itemMatch && !isOrdered) {
      items.push(parseInlineMarkdown(itemMatch[1]));
      i++;
    } else if (orderedItemMatch && isOrdered) {
      items.push(parseInlineMarkdown(orderedItemMatch[2]));
      i++;
    } else if (trimmed.startsWith('  ') || trimmed.startsWith('\t')) {
      // 缩进行，作为上一项的延续
      if (items.length > 0) {
        items[items.length - 1] += ' ' + trimmed.trim();
      }
      i++;
    } else {
      break;
    }
  }

  paragraphs.push({
    type: 'list',
    listType: isOrdered ? 'ordered' : 'unordered',
    items
  });

  return { paragraphs, nextIndex: i };
}

/**
 * 解析引用块
 */
function parseBlockquote(lines, startIndex) {
  const lines_text = [];
  let i = startIndex;

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('>')) break;
    lines_text.push(trimmed.substring(1).trim());
    i++;
  }

  return {
    para: {
      type: 'quote',
      text: lines_text.join('\n')
    },
    nextIndex: i
  };
}

/**
 * 解析普通段落
 */
function parseParagraph(lines, startIndex) {
  const text = [];
  let i = startIndex;

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    // 空行结束段落
    if (!trimmed) break;

    // 特殊行结束段落
    if (trimmed.startsWith('#') ||
        trimmed.startsWith('```') ||
        trimmed.startsWith('-') ||
        trimmed.startsWith('*') ||
        trimmed.match(/^\d+\./) ||
        trimmed.startsWith('>')) {
      break;
    }

    text.push(lines[i]);
    i++;
  }

  return {
    para: {
      type: 'text',
      text: text.join('\n')
    },
    nextIndex: i
  };
}

/**
 * 解析行内 Markdown 格式
 * @param {string} text - 文本
 * @returns {Array} - 文本元素数组
 */
function parseInlineMarkdown(text) {
  const elements = [];
  let remaining = text;
  let pos = 0;

  while (pos < remaining.length) {
    // 检查粗体 **text**
    const boldMatch = remaining.slice(pos).match(/^\*\*([^*]+?)\*\*/);
    if (boldMatch) {
      if (pos > 0) {
        elements.push({ tag: 'text', text: remaining.slice(0, pos) });
      }
      elements.push({ tag: 'b', text: boldMatch[1] });
      remaining = remaining.slice(pos + boldMatch[0].length);
      pos = 0;
      continue;
    }

    // 检查斜体 *text*
    const italicMatch = remaining.slice(pos).match(/^\*([^*]+?)\*/);
    if (italicMatch) {
      if (pos > 0) {
        elements.push({ tag: 'text', text: remaining.slice(0, pos) });
      }
      elements.push({ tag: 'i', text: italicMatch[1] });
      remaining = remaining.slice(pos + italicMatch[0].length);
      pos = 0;
      continue;
    }

    // 检查行内代码 `code`
    const codeMatch = remaining.slice(pos).match(/^`([^`]+?)`/);
    if (codeMatch) {
      if (pos > 0) {
        elements.push({ tag: 'text', text: remaining.slice(0, pos) });
      }
      elements.push({ tag: 'code', text: codeMatch[1] });
      remaining = remaining.slice(pos + codeMatch[0].length);
      pos = 0;
      continue;
    }

    // 检查链接 [text](url)
    const linkMatch = remaining.slice(pos).match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      if (pos > 0) {
        elements.push({ tag: 'text', text: remaining.slice(0, pos) });
      }
      elements.push({
        tag: 'a',
        text: linkMatch[1],
        href: linkMatch[2]
      });
      remaining = remaining.slice(pos + linkMatch[0].length);
      pos = 0;
      continue;
    }

    pos++;
  }

  if (remaining) {
    elements.push({ tag: 'text', text: remaining });
  }

  return elements.length > 0 ? elements : [{ tag: 'text', text }];
}

/**
 * 将段落转换为飞书富文本元素数组
 * 飞书 post 类型格式：content 是二维数组，每段是一个一维数组
 * @param {Object} para - 段落对象
 * @returns {Array} - 元素数组（一维）
 */
function convertParagraph(para) {
  switch (para.type) {
    case 'heading':
      return [{
        tag: 'heading',
        heading_level: Math.min(para.level, 9), // 飞书支持 1-9 级标题
        text: [{ tag: 'text', text: para.text }]
      }];

    case 'code':
      return [{
        tag: 'code',
        style: { language: normalizeLanguage(para.language) },
        text: [{ tag: 'text', text: para.text }]
      }];

    case 'list':
      // 列表所有项作为一个段落，items 是数组
      return [{
        tag: para.listType === 'ordered' ? 'ol' : 'ul',
        items: para.items.map(item =>
          typeof item === 'string' ? [{ tag: 'text', text: item }] : item
        )
      }];

    case 'quote':
      return [{
        tag: 'quote',
        quote_type: 1,
        elements: [[{ tag: 'text', text: para.text }]]
      }];

    case 'text':
    default:
      // 解析行内格式
      return parseInlineMarkdown(para.text);
  }
}

/**
 * 标准化语言标识
 */
function normalizeLanguage(lang) {
  const langMap = {
    'js': 'javascript',
    'ts': 'typescript',
    'py': 'python',
    'c++': 'cpp',
    'c#': 'csharp',
    'sh': 'bash',
    'yml': 'yaml',
    'md': 'markdown',
  };

  const lower = lang.toLowerCase();
  return langMap[lower] || lower || 'plaintext';
}

/**
 * 从富文本提取纯文本
 * @param {Object} richText - 飞书富文本对象
 * @returns {string} - 纯文本
 */
export function richTextToPlainText(richText) {
  if (!richText || !richText.post || !richText.post.zh_cn) {
    return '';
  }

  const paragraphs = richText.post.zh_cn;
  const lines = [];

  for (const para of paragraphs) {
    const line = extractTextFromElements(para);
    if (line) {
      lines.push(line);
    }
  }

  return lines.join('\n');
}

/**
 * 从元素数组中提取文本
 */
function extractTextFromElements(elements) {
  if (!Array.isArray(elements)) {
    return '';
  }

  return elements.map(el => {
    switch (el.tag) {
      case 'text':
        return el.text || '';
      case 'b':
      case 'i':
        return el.text || '';
      case 'code':
        return '`' + (el.text || '') + '`';
      case 'a':
        return el.text || el.href || '';
      case 'heading':
        return '#'.repeat(el.heading_level || 1) + ' ' + extractTextFromElements(el.text || []);
      case 'quote':
        return extractTextFromElements(el.elements?.[0] || []);
      default:
        return '';
    }
  }).join('');
}

export default {
  markdownToFeishuRichText,
  richTextToPlainText,
};
