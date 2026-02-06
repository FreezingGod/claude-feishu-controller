/**
 * 飞书 Markdown 转换器
 * 将标准 Markdown 转换为飞书 lark_md 支持的格式
 *
 * 飞书 lark_md 支持的语法：
 * - 标题：# ## ### 等
 * - 粗体：**text**
 * - 斜体：*text*
 * - 删除线：~~text~~
 * - 行内代码：`code`
 * - 代码块：```language\ncode\n```
 * - 链接：[text](url)
 * - @用户：<at id=xxx></at>
 * - 表情：:emoji: 或直接 emoji
 * - 引用：> text
 * - 无序列表：- 或 *
 * - 有序列表：1.
 */

/**
 * 清理和转换 Markdown 为飞书 lark_md 兼容格式
 * @param {string} markdown - 原始 Markdown 文本
 * @param {Object} options - 转换选项
 * @returns {string} - 转换后的 Markdown
 */
export function toLarkMarkdown(markdown, options = {}) {
  const {
    maxCodeBlockLength = 3000, // 代码块最大长度
    preserveEmptyLines = false, // 是否保留空行
    enableEmoji = true, // 是否保留 emoji
  } = options;

  if (!markdown || typeof markdown !== 'string') {
    return '';
  }

  let result = markdown;

  // 1. 处理代码块（优先处理，避免内部被其他规则影响）
  result = processCodeBlocks(result, maxCodeBlockLength);

  // 2. 处理行内代码（已被代码块处理保护，只处理剩余的）
  result = processInlineCode(result);

  // 3. 处理标题（确保标题前有空行）
  result = processHeadings(result);

  // 4. 处理列表（确保列表格式正确）
  result = processLists(result);

  // 5. 处理引用（确保 > 后有空格）
  result = processBlockquotes(result);

  // 6. 处理粗体、斜体、删除线
  result = processTextStyles(result);

  // 7. 处理链接（确保链接格式正确）
  result = processLinks(result);

  // 8. 清理多余的空行
  if (!preserveEmptyLines) {
    result = removeExtraEmptyLines(result);
  }

  // 9. 处理水平线
  result = processHorizontalRules(result);

  // 10. 清理末尾空白
  result = result.trim();

  return result;
}

/**
 * 处理代码块
 * 确保代码块格式符合飞书要求：```language\ncode\n```
 */
function processCodeBlocks(text, maxLength) {
  // 匹配代码块（包括带有语言标识的）
  const codeBlockPattern = /```(\w*)\n([\s\S]*?)```/g;

  return text.replace(codeBlockPattern, (match, lang, code) => {
    // 清理代码内容
    let cleanedCode = code.trim();

    // 如果代码过长，截断并添加提示
    if (cleanedCode.length > maxLength) {
      cleanedCode = cleanedCode.slice(0, maxLength) + '\n// ... (代码过长，已截断)';
    }

    // 确保语言标识有效（飞书支持的语言）
    const validLang = validateLanguage(lang);

    return `\`\`\`${validLang}\n${cleanedCode}\n\`\`\``;
  });
}

/**
 * 处理行内代码
 */
function processInlineCode(text) {
  // 处理单个反引号的行内代码
  // 这个正则确保不会匹配到已经处理过的代码块
  return text.replace(/(?<!`)`([^`\n]+)`(?!`)/g, (match, code) => {
    return `\`${code.trim()}\``;
  });
}

/**
 * 处理标题
 * 确保标题格式正确
 */
function processHeadings(text) {
  const lines = text.split('\n');
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 检查是否是标题（# 开头）
    if (/^#{1,6}\s/.test(trimmed)) {
      // 确保标题前有空行（除非是第一行）
      if (i > 0 && lines[i - 1].trim() !== '') {
        const prevLine = result[result.length - 1];
        if (prevLine && prevLine.trim() !== '') {
          result.push('');
        }
      }
      result.push(trimmed);
    } else {
      result.push(line);
    }
  }

  return result.join('\n');
}

/**
 * 处理列表
 * 确保列表格式正确
 */
function processLists(text) {
  const lines = text.split('\n');
  const result = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // 无序列表：- 或 * 开头
    if (/^[\-\*]\s/.test(trimmed)) {
      // 统一使用 - 作为无序列表标记
      const content = trimmed.substring(1).trim();
      result.push(`- ${content}`);
    }
    // 有序列表：数字. 开头
    else if (/^\d+\.\s/.test(trimmed)) {
      result.push(trimmed);
    } else {
      result.push(line);
    }
  }

  return result.join('\n');
}

/**
 * 处理引用块
 */
function processBlockquotes(text) {
  const lines = text.split('\n');
  const result = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // 引用：> 开头
    if (trimmed.startsWith('>')) {
      // 确保 > 后有空格
      if (trimmed.length > 1 && trimmed[1] !== ' ') {
        result.push(`> ${trimmed.substring(1).trim()}`);
      } else {
        result.push(line);
      }
    } else {
      result.push(line);
    }
  }

  return result.join('\n');
}

/**
 * 处理文本样式（粗体、斜体、删除线）
 */
function processTextStyles(text) {
  // 确保粗体格式正确：**text**（中间至少一个字符）
  text = text.replace(/\*\*([^\*]+)\*\*/g, (match, content) => {
    return `**${content.trim()}**`;
  });

  // 确保斜体格式正确：*text*（中间至少一个字符）
  text = text.replace(/(?<!\*)\*([^\*]+)\*(?!\*)/g, (match, content) => {
    return `*${content.trim()}*`;
  });

  // 确保删除线格式正确：~~text~~
  text = text.replace(/~~([^~]+)~~/g, (match, content) => {
    return `~~${content.trim()}~~`;
  });

  return text;
}

/**
 * 处理链接
 * 确保链接格式正确：[text](url)
 */
function processLinks(text) {
  // 匹配标准 Markdown 链接
  const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;

  return text.replace(linkPattern, (match, text, url) => {
    // 清理 URL
    const cleanUrl = url.trim();
    // 清理链接文本
    const cleanText = text.trim();
    return `[${cleanText}](${cleanUrl})`;
  });
}

/**
 * 移除多余的空行
 * 将连续的空行减少为最多一行
 */
function removeExtraEmptyLines(text) {
  return text.replace(/\n{3,}/g, '\n\n');
}

/**
 * 处理水平线
 * 转换为飞书支持的格式
 */
function processHorizontalRules(text) {
  // 飞书支持 --- 水平线
  return text.replace(/^[ \t]*[_\-*]{3,}[ \t]*$/gm, '---');
}

/**
 * 验证并返回飞书支持的语言标识
 */
function validateLanguage(lang) {
  // 飞书支持的代码语言列表
  const supportedLangs = [
    'js', 'javascript', 'typescript', 'ts',
    'python', 'py', 'java', 'kotlin', 'scala',
    'c', 'cpp', 'c++', 'csharp', 'c#', 'go', 'rust',
    'ruby', 'php', 'swift', 'objc', 'shell', 'bash',
    'sql', 'html', 'css', 'xml', 'json', 'yaml', 'yml',
    'markdown', 'md', 'dockerfile', 'docker', 'makefile',
    'nginx', 'apache', 'vim', 'lua', 'r', 'matlab',
    'perl', 'dart', 'elixir', 'erlang', 'haskell', 'julia'
  ];

  const lowerLang = lang.toLowerCase().trim();

  if (!lowerLang) {
    return ''; // 空语言标识
  }

  // 检查是否在支持列表中
  if (supportedLangs.includes(lowerLang)) {
    return lowerLang;
  }

  // 尝试映射常见语言别名
  const aliases = {
    'js': 'javascript',
    'ts': 'typescript',
    'py': 'python',
    'c++': 'cpp',
    'c#': 'csharp',
    'sh': 'bash',
    'yml': 'yaml',
    'md': 'markdown',
  };

  return aliases[lowerLang] || lowerLang;
}

/**
 * 从 Markdown 中提取纯文本（用于消息摘要）
 * @param {string} markdown - Markdown 文本
 * @param {number} maxLength - 最大长度
 * @returns {string} - 纯文本
 */
export function extractPlainText(markdown, maxLength = 200) {
  if (!markdown) return '';

  let text = markdown;

  // 移除代码块
  text = text.replace(/```[\s\S]*?```/g, '[代码块]');

  // 移除行内代码
  text = text.replace(/`[^`]+`/g, (match) => match.replace(/`/g, ''));

  // 移除链接标记，保留文本
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // 移除粗体、斜体、删除线标记
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/~~([^~]+)~~/g, '$1');

  // 移除标题标记
  text = text.replace(/^#{1,6}\s+/gm, '');

  // 移除引用标记
  text = text.replace(/^>\s+/gm, '');

  // 移除列表标记
  text = text.replace(/^[\-\*]\s+/gm, '');
  text = text.replace(/^\d+\.\s+/gm, '');

  // 清理多余空行
  text = text.replace(/\n{3,}/g, '\n\n');

  // 截断
  if (text.length > maxLength) {
    text = text.slice(0, maxLength) + '...';
  }

  return text.trim();
}

/**
 * 检测文本是否包含飞书不支持的 Markdown 语法
 * @param {string} markdown - Markdown 文本
 * @returns {Object} - { hasUnsupported: boolean, issues: string[] }
 */
export function detectUnsupportedSyntax(markdown) {
  const issues = [];

  // 检查是否包含表格（飞书 lark_md 不支持）
  if (/^\|.*\|$/m.test(markdown)) {
    issues.push('包含表格语法，飞书卡片不完全支持');
  }

  // 检查是否包含 HTML 标签
  if (/<[^>]+>/.test(markdown)) {
    issues.push('包含 HTML 标签，建议移除');
  }

  // 检查是否包含任务列表
  if (/^\s*[\-\*]\s*\[[ x]\]\s/m.test(markdown)) {
    issues.push('包含任务列表语法，飞书显示为普通列表');
  }

  return {
    hasUnsupported: issues.length > 0,
    issues
  };
}

export default {
  toLarkMarkdown,
  extractPlainText,
  detectUnsupportedSyntax,
};
