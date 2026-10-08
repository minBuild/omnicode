/** jsdom 보충: <dialog> 의 showModal/close (jsdom 에 없다), 테스트마다 DOM 정리 */
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => cleanup());

const proto = HTMLDialogElement.prototype as HTMLDialogElement & { showModal?: () => void; close?: (rv?: string) => void };
if (typeof proto.showModal !== 'function') {
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
}
if (typeof proto.close !== 'function' || !('open' in proto)) {
  proto.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}
