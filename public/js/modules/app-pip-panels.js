// The thread panel and the pop-out DM panel: their buttons, inputs, pasting
// and dropping files, message actions, resizing and dragging.

export default {

_bindThreadAndDmPanels() {
  // Thread panel — close, send
  const threadCloseBtn = document.getElementById('thread-panel-close');
  if (threadCloseBtn) threadCloseBtn.addEventListener('click', () => this._closeThread());

  const threadPipBtn = document.getElementById('thread-panel-pip');
  if (threadPipBtn) threadPipBtn.addEventListener('click', () => this._toggleThreadPiP());

  // Thread @mention pill in the channel header
  const tmPill = document.getElementById('thread-mentions-pill');
  if (tmPill) tmPill.addEventListener('click', () => this._openMostRecentThreadMention?.());

  // DM PiP panel buttons
  const dmPipClose = document.getElementById('dm-pip-close');
  if (dmPipClose) dmPipClose.addEventListener('click', () => this._closeDMPiP?.());
  const dmPipFs = document.getElementById('dm-pip-fullscreen');
  if (dmPipFs) dmPipFs.addEventListener('click', () => {
    const code = this._activeDMPip;
    if (!code) return;
    this._closeDMPiP?.();
    this.switchChannel(code);
  });
  const dmPipSend = document.getElementById('dm-pip-send');
  if (dmPipSend) dmPipSend.addEventListener('click', () => this._sendDMPiPMessage?.());
  const dmPipInput = document.getElementById('dm-pip-input');
  if (dmPipInput) dmPipInput.addEventListener('keydown', (e) => {
    // Autocomplete navigation/insert hijacks first. (#5296)
    if (this._handleAutocompleteKeydown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this._sendDMPiPMessage?.();
      return;
    }
    // Markdown Formatting shortcuts
    if (this._handleMarkdownShortcuts(dmPipInput, e)) {
      e.preventDefault();
      return;
    }
  });
  if (dmPipInput) dmPipInput.addEventListener('input', () => {
    this._checkMentionTrigger(dmPipInput);
    this._checkChannelTrigger(dmPipInput);
    this._checkEmojiTrigger(dmPipInput);
    this._checkSlashTrigger(dmPipInput);
    // Personas are not supported in DMs — omit _checkPersonaTrigger here
  });

  // Paste images / files into the DM PiP input — queues images for preview
  // (same as main channel paste behavior). (#5324)
  if (dmPipInput) dmPipInput.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const targetCode = this._activeDMPip;
    if (!targetCode) return;
    let handled = false;
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      handled = true;
      if (item.type.startsWith('image/')) {
        this._queueImageForPiP(file, targetCode);
      } else {
        this._uploadGeneralFile(file, targetCode);
      }
    }
    if (handled) return;

    // insert a markdown link when a link is pasted over selected text
    if (this._handleMarkdownLinkPaste(dmPipInput, e)) {
      e.preventDefault();
    }
  });

  // A paperclip and drag-and-drop in the pop-out DM, since paste was the
  // only way to send a picture from it, and middle-click opens a picture
  // there and in a thread like it does in chat (#5663).
  const dmPipUploadBtn = document.getElementById('dm-pip-upload-btn');
  const dmPipFileInput = document.getElementById('dm-pip-file-input');
  const dmPipTakeFiles = (files) => {
    const targetCode = this._activeDMPip;
    if (!files || !files.length || !targetCode) return false;
    for (const file of files) {
      if (file.type.startsWith('image/')) this._queueImageForPiP(file, targetCode);
      else this._uploadGeneralFile(file, targetCode);
    }
    return true;
  };
  if (dmPipUploadBtn && dmPipFileInput) {
    dmPipUploadBtn.addEventListener('click', (e) => { e.stopPropagation(); dmPipFileInput.click(); });
    dmPipFileInput.addEventListener('change', () => {
      dmPipTakeFiles(dmPipFileInput.files);
      dmPipFileInput.value = '';
    });
  }
  const dmPipPanel = document.getElementById('dm-pip-panel');
  if (dmPipPanel) {
    dmPipPanel.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
    });
    dmPipPanel.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      e.stopPropagation();
      dmPipTakeFiles(e.dataTransfer.files);
    });
  }

  // PiP emoji button — positions the picker above the button and targets the PiP input
  const dmPipEmojiBtn = document.getElementById('dm-pip-emoji-btn');
  if (dmPipEmojiBtn) {
    dmPipEmojiBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._activeEditTextarea = document.getElementById('dm-pip-input');
      this._emojiPickerContext = 'dmpip';
      this._toggleEmojiPicker(dmPipEmojiBtn);
    });
  }

  const dmPipReplyClose = document.getElementById('dm-pip-reply-close-btn');
  if (dmPipReplyClose) dmPipReplyClose.addEventListener('click', () => this._clearDMPiPReply?.());

  // Delegated message-action handler for the DM PiP.  Mirrors the main
  // #messages handler so reactions/reply/edit/etc. work inside the PiP.
  const dmPipMessages = document.getElementById('dm-pip-messages');
  if (dmPipMessages) {
    dmPipMessages.addEventListener('click', async (e) => {
      // Toolbar action buttons
      // Inline ⋯ dots button — reveals the full toolbar (touch/mobile)
      const dotsBtn = e.target.closest('.msg-dots-btn');
      if (dotsBtn) {
        e.stopPropagation();
        const msgEl = dotsBtn.closest('.message, .message-compact');
        if (!msgEl) return;
        const wasSelected = msgEl.classList.contains('msg-selected');
        dmPipMessages.querySelectorAll('.msg-selected').forEach(el => {
          el.classList.remove('msg-selected');
          const tb = el.querySelector('.msg-toolbar');
          if (tb) tb.style.removeProperty('display');
        });
        if (!wasSelected) {
          msgEl.classList.add('msg-selected');
          const tb = msgEl.querySelector('.msg-toolbar');
          if (tb) tb.style.setProperty('display', 'flex', 'important');
        }
        return;
      }

      const actionBtn = e.target.closest('[data-action]');
      if (actionBtn) {
        const msgEl = actionBtn.closest('.message, .message-compact');
        if (!msgEl) return;
        const msgId = parseInt(msgEl.dataset.msgId, 10);
        if (!msgId) return;
        const action = actionBtn.dataset.action;
        if (action === 'react') {
          this._showReactionPicker?.(msgEl, msgId);
        } else if (action === 'reply') {
          this._setDMPiPReply?.(msgEl, msgId);
        } else if (action === 'quote') {
          this._quoteDMPiPMessage?.(msgEl);
        } else if (action === 'edit') {
          this._startEditMessage?.(msgEl, msgId);
        } else if (action === 'delete') {
          if (await this._showConfirmModal(t('confirm.delete_message'), '', { danger: true, confirmLabel: t('msg_toolbar.delete') })) {
            this.socket.emit('delete-message', { messageId: msgId, channelCode: this._activeDMPip, attachments: this._getMessageAttachments?.(msgId) });
          }
        } else if (action === 'pin') {
          if (await this._showConfirmModal(t('confirm.pin_message'), '')) {
            this.socket.emit('pin-message', { messageId: msgId });
          }
        } else if (action === 'unpin') {
          this.socket.emit('unpin-message', { messageId: msgId });
        } else if (action === 'archive') {
          this.socket.emit('archive-message', { messageId: msgId });
        } else if (action === 'unarchive') {
          this.socket.emit('unarchive-message', { messageId: msgId });
        } else if (action === 'copy-link') {
          this._copyChannelLink?.(this._activeDMPip, msgId);
        } else if (action === 'thread') {
          // Threads are not available in DMs - swallow the click. The button
          // should already be filtered out at render time, this is defence
          // in depth in case an old cached element is still around.
          this._showToast?.(t('thread_list.unavailable_in_dm'), 'info');
        }
        return;
      }
      // Reaction badge toggle
      const badge = e.target.closest('.reaction-badge');
      if (badge) {
        this._hideReactionPopout?.();
        const msgEl = badge.closest('.message, .message-compact');
        if (!msgEl) return;
        const msgId = parseInt(msgEl.dataset.msgId, 10);
        const emoji = badge.dataset.emoji;
        if (!msgId || !emoji) return;
        if (badge.classList.contains('own')) {
          this.socket.emit('remove-reaction', { messageId: msgId, emoji });
        } else {
          this.socket.emit('add-reaction', { messageId: msgId, emoji });
        }
        return;
      }
      // Reply banner click → jump to original (within the PiP if present)
      const replyBanner = e.target.closest('.reply-banner');
      if (replyBanner) {
        const replyMsgId = parseInt(replyBanner.dataset.replyMsgId || '', 10);
        if (!replyMsgId) return;
        const target = dmPipMessages.querySelector(`[data-msg-id="${replyMsgId}"]`);
        if (target) {
          target.scrollIntoView({ block: 'center', behavior: 'smooth' });
          target.classList.add('highlight-flash');
          setTimeout(() => target.classList.remove('highlight-flash'), 1200);
        }
      }
    });
  }

  const threadSendBtn = document.getElementById('thread-send-btn');
  if (threadSendBtn) threadSendBtn.addEventListener('click', () => this._sendThreadMessage());

  // Thread emoji button — positions the picker above the button and targets the thread input
  const threadEmojiBtn = document.getElementById('thread-emoji-btn');
  if (threadEmojiBtn) {
    threadEmojiBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._activeEditTextarea = document.getElementById('thread-input');
      this._emojiPickerContext = 'thread';
      this._toggleEmojiPicker(threadEmojiBtn);
    });
  }

  const threadInput = document.getElementById('thread-input');
  if (threadInput) {
    threadInput.addEventListener('keydown', (e) => {
      // Autocomplete navigation/insert hijacks first. (#5296)
      if (this._handleAutocompleteKeydown(e)) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._sendThreadMessage();
        return;
      }
      // Markdown Formatting shortcuts
      if (this._handleMarkdownShortcuts(threadInput, e)) {
        e.preventDefault();
        return;
      }
    });
    threadInput.addEventListener('input', () => {
      this._checkMentionTrigger(threadInput);
      this._checkChannelTrigger(threadInput);
      this._checkEmojiTrigger(threadInput);
      this._checkSlashTrigger(threadInput);
      // Personas are not supported in threads — omit _checkPersonaTrigger here
    });
    // Paste images / files into the thread input — upload then send as thread message
    threadInput.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      if (!this._activeThreadParent) return;
      // Hold them, don't post them. Flushed on send. (#thread-paste-instant)
      const files = Array.from(items).filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
      if (files.length) {
        e.preventDefault();
        this._queueThreadFiles(files);
        return;
      }

      // insert a markdown link when a link is pasted over selected text
      if (this._handleMarkdownLinkPaste(threadInput, e)) {
        e.preventDefault();
      }
    });

    // Drag & drop parity with the other composers — queue, never insta-post.
    // The whole panel takes the drop, not only the reply box: in a forum topic
    // people drop pictures onto the replies the way they would onto a chat
    // (#5684).
    const threadArea = threadInput.closest('.thread-panel') || threadInput.closest('.thread-input-area') || threadInput;
    const hasFiles = (e) => !!e.dataTransfer?.types?.includes('Files');
    threadArea.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); threadArea.classList.add('drag-over'); });
    threadArea.addEventListener('dragleave', (e) => { if (!threadArea.contains(e.relatedTarget)) threadArea.classList.remove('drag-over'); });
    threadArea.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      threadArea.classList.remove('drag-over');
      if (!this._activeThreadParent) return;
      this._queueThreadFiles(e.dataTransfer?.files);
    });
  }

  const threadReplyCloseBtn = document.getElementById('thread-reply-close-btn');
  if (threadReplyCloseBtn) threadReplyCloseBtn.addEventListener('click', () => this._clearThreadReply());

  // Thread panel width resize (drag left edge)
  const threadPanel = document.getElementById('thread-panel');
  const threadResizer = document.getElementById('thread-panel-resizer');
  if (threadPanel) {
    const savedWidth = parseInt(localStorage.getItem('haven_thread_panel_width') || '', 10);
    if (Number.isFinite(savedWidth) && savedWidth >= 300 && savedWidth <= 920) {
      threadPanel.style.width = `${savedWidth}px`;
    }
  }
  if (threadPanel && threadResizer) {
    let resizing = false;
    const clampWidth = (w) => {
      const min = 300;
      const max = Math.min(920, window.innerWidth - 220);
      return Math.max(min, Math.min(max, w));
    };
    const onMove = (e) => {
      if (!resizing || threadPanel.classList.contains('pip')) return;
      const width = clampWidth(window.innerWidth - e.clientX);
      threadPanel.style.width = `${width}px`;
    };
    const onUp = () => {
      if (!resizing) return;
      resizing = false;
      document.body.classList.remove('resizing-thread-panel');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const current = parseInt(threadPanel.style.width || '', 10);
      if (Number.isFinite(current)) {
        localStorage.setItem('haven_thread_panel_width', String(clampWidth(current)));
      }
    };
    threadResizer.addEventListener('mousedown', (e) => {
      if (threadPanel.classList.contains('pip')) return;
      resizing = true;
      e.preventDefault();
      document.body.classList.add('resizing-thread-panel');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    window.addEventListener('resize', () => {
      if (threadPanel.classList.contains('pip')) return;
      const current = parseInt(threadPanel.style.width || '', 10);
      if (!Number.isFinite(current)) return;
      const width = clampWidth(current);
      if (width !== current) {
        threadPanel.style.width = `${width}px`;
        localStorage.setItem('haven_thread_panel_width', String(width));
      }
    });
  }

  // Thread panel PiP drag (drag by header)
  if (threadPanel) {
    const threadHeaderTop = threadPanel.querySelector('.thread-panel-header-top');
    let draggingPiP = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    const footerOffset = () => {
      const raw = getComputedStyle(document.body).getPropertyValue('--thread-footer-offset');
      const v = parseInt(raw, 10);
      return Number.isFinite(v) ? v : 0;
    };

    const clampPiPRect = (left, top, width, height) => {
      const maxLeft = Math.max(0, window.innerWidth - width);
      const maxTop = Math.max(0, window.innerHeight - footerOffset() - height);
      return {
        left: Math.max(0, Math.min(maxLeft, left)),
        top: Math.max(0, Math.min(maxTop, top))
      };
    };

    const savePiPRect = () => {
      if (!threadPanel.classList.contains('pip')) return;
      const r = threadPanel.getBoundingClientRect();
      const rect = {
        left: Math.round(r.left),
        top: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height)
      };
      localStorage.setItem('haven_thread_panel_pip_rect', JSON.stringify(rect));
    };

    const onPiPMove = (e) => {
      if (!draggingPiP || !threadPanel.classList.contains('pip')) return;
      const r = threadPanel.getBoundingClientRect();
      const rawLeft = e.clientX - dragOffsetX;
      const rawTop = e.clientY - dragOffsetY;
      const pos = clampPiPRect(rawLeft, rawTop, r.width, r.height);
      threadPanel.style.left = `${pos.left}px`;
      threadPanel.style.top = `${pos.top}px`;
      threadPanel.style.right = 'auto';
      threadPanel.style.bottom = 'auto';
    };

    const onPiPUp = () => {
      if (!draggingPiP) return;
      draggingPiP = false;
      document.removeEventListener('mousemove', onPiPMove);
      document.removeEventListener('mouseup', onPiPUp);
      savePiPRect();
    };

    if (threadHeaderTop) {
      threadHeaderTop.addEventListener('mousedown', (e) => {
        if (!threadPanel.classList.contains('pip')) return;
        if (e.target.closest('button, input, textarea, a')) return;
        const r = threadPanel.getBoundingClientRect();
        draggingPiP = true;
        dragOffsetX = e.clientX - r.left;
        dragOffsetY = e.clientY - r.top;
        threadPanel.style.right = 'auto';
        threadPanel.style.bottom = 'auto';
        e.preventDefault();
        document.addEventListener('mousemove', onPiPMove);
        document.addEventListener('mouseup', onPiPUp);
      });
    }

    if (window.ResizeObserver) {
      const observer = new ResizeObserver(() => {
        if (!threadPanel.classList.contains('pip')) return;
        clearTimeout(this._threadPiPSaveTimer);
        this._threadPiPSaveTimer = setTimeout(() => {
          const r = threadPanel.getBoundingClientRect();
          const pos = clampPiPRect(r.left, r.top, r.width, r.height);
          threadPanel.style.left = `${pos.left}px`;
          threadPanel.style.top = `${pos.top}px`;
          savePiPRect();
        }, 80);
      });
      observer.observe(threadPanel);
    }
  }

  // PiP input area height resize — drag the top handle upward to expand the textarea.
  // Used by DM PiP, thread input, AND the main channel composer (#5327).
  // We set both `height` and `min-height` inline so the auto-grow `input`
  // handler (which sets `height = 'auto'` then caps at a small default) can't
  // collapse the textarea back down after the user has manually expanded it.
  document.querySelectorAll('.pip-input-resizer').forEach(handle => this._bindInputResizer(handle));
},

};
