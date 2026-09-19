// The three pages a person is entitled to read before they trust software
// with a confidential document, and the three Paddle expects to find before
// it will take money through one.
//
// Written from what the program does, not from a template. Every claim here
// is checkable against the source in this repository, which is the point --
// a privacy policy that cannot be checked is a paragraph, not a promise. The
// self-test holds the refund window here to the one the premium page quotes,
// because two different numbers on two pages is the kind of thing nobody
// notices until somebody is asking for their money back.

// Kept in one place: the premium page says it, the refund page says it, and
// they are not allowed to disagree.
export const REFUND_HOURS = 72;

export const CONTACT = 'support@blinded.dev';

// Where the law question gets answered. Until somebody who knows says
// otherwise this names no country, because naming the wrong one is worse
// than naming none -- and the self-test will not let it be forgotten.
export const JURISDICTION = null;

export const pages = [
  {
    slug: 'privacy',
    title: 'Privacy and security',
    h1: 'Privacy and security',
    description: 'Blinded never receives your document. No accounts, no '
      + 'analytics, no cookies. What is stored, where, and what we could not '
      + 'hand over if we were asked.',
    sections: [
      { h: 'The short version',
        p: ['Your document is never sent anywhere. It is opened, read, '
          + 'searched and rewritten inside the tab you opened it in, by code '
          + 'that arrived with the page, and the finished file is written by '
          + 'your own browser onto your own disk.',
          'This is not a promise about how carefully we look after your data. '
          + 'It is a statement that we never receive it, which is a different '
          + 'kind of claim and a much easier one to keep. There is no upload '
          + 'endpoint on this site to send a document to. You can watch the '
          + 'network panel while you work and see that nothing leaves.'] },

      { h: 'What we collect',
        p: ['Nothing, through the tool. No account, no sign-up, no email '
          + 'address, no analytics, no cookies, no tracking pixel, no '
          + 'third-party script of any kind on the page that holds your '
          + 'document. Its content security policy forbids it from reaching '
          + 'anything at all, and that policy is served as a header as well as '
          + 'written in the page, so it cannot be quietly relaxed.',
          'We do not know how many documents you have redacted, how long they '
          + 'were, what was in them, or that you used the tool today.'] },

      { h: 'What is stored on your own machine',
        p: ['One thing: if you buy a license, the license itself is kept in your '
          + 'browser’s local storage so you do not have to paste it again. '
          + 'It is a short signed string saying that somebody bought a license '
          + 'and when it expires. It carries nothing about who you are. You '
          + 'can clear it at any time by clearing this site’s data.',
          'A draft is a file you download. It holds your marks and the words '
          + 'you typed, never the document, and it goes to your own disk like '
          + 'any other download. We never see it.'] },

      { h: 'If you buy a license',
        p: ['Payment is handled by Paddle, which is the merchant of record: '
          + 'they sell the licence, take the card details and handle the tax. '
          + 'We never see your card number. The name, email address and '
          + 'country you give at checkout are held by Paddle under their own '
          + 'privacy policy, and they are the ones who send your receipt.',
          'Our own service that signs licenses stores one row per purchase: the '
          + 'transaction id, the signed license, when it was made and when it '
          + 'expires. Not your name, not your email address, not your country. '
          + 'Rows are deleted once the license they describe has expired. That '
          + 'service has never been given a document and has no way to ask for '
          + 'one.',
          'Checking a license happens on your machine, against a public key that '
          + 'came with the page. Using one sends no request to us — so we do '
          + 'not learn that you exported a document, when, or what it was.'] },

      { h: 'What our hosting sees',
        p: ['The site is served as static files by a hosting provider, and '
          + 'like any web server theirs keeps ordinary access logs: the IP '
          + 'address that asked for a page, the time, the file requested. That '
          + 'is the normal operation of a web server and we are not going to '
          + 'claim otherwise.',
          'What those logs cannot contain is anything about your document, '
          + 'because the document is never part of a request. They record that '
          + 'somebody loaded a page, not what they did with it.'] },

      { h: 'How the page is defended',
        p: ['A content security policy that allows no framing, no external '
          + 'script and no outbound connection, sent as a response header so '
          + 'it holds before the page is parsed. Strict transport security, so '
          + 'a browser that has been here once will not be talked back onto '
          + 'plain http. No third-party code on the tool page at all.',
          'Buying happens on a separate page with a policy of its own, which '
          + 'is the only page on this site permitted to reach a payment '
          + 'processor. That separation exists so that the page holding a '
          + 'document has exactly the permissions it had before there was '
          + 'anything to buy.',
          'The source is published. The claim that nothing is uploaded is one '
          + 'you should be able to check rather than take on trust, and you '
          + 'cannot check a program you cannot read.'] },

      { h: 'What we could not do if we were asked',
        p: ['We could not hand over your document, because we have never had '
          + 'it. We could not tell anybody what you redacted, when you used '
          + 'the tool, or whether you have ever used it. There is no record to '
          + 'produce. This is a property of the design rather than a policy we '
          + 'have adopted, which means it does not change when our policies '
          + 'change.',
          'We could not recover a document you lost, either. The same fact '
          + 'cuts both ways, and it is worth knowing before you close the tab.'] },

      { h: 'Children',
        p: ['This is a tool for handling business and professional documents '
          + 'and is not directed at children. We do not knowingly collect '
          + 'anything from anybody, of any age.'] },

      { h: 'Changes, and how to ask',
        p: ['If this page changes in a way that matters, the change will be '
          + 'visible in the repository’s history like every other change to '
          + 'this site.',
          'Questions about any of it: ' + CONTACT + '.'] },
    ],
  },

  {
    slug: 'terms',
    title: 'Terms of service',
    h1: 'Terms of service',
    description: 'The terms for using Blinded and for buying a license: what a '
      + 'license is, what the tool does not promise, and who is responsible for '
      + 'checking a redaction.',
    sections: [
      { h: 'What this is',
        p: ['Blinded is a document redaction tool that runs entirely in your '
          + 'browser. Using it means accepting these terms. If you do not '
          + 'accept them, do not use it.',
          'These terms cover the hosted tool at blinded.dev and any license '
          + 'bought through it.'] },

      { h: 'The thing you must read',
        p: ['<strong>You are responsible for checking the output.</strong> '
          + 'Blinded rebuilds a document as images so that covered text cannot '
          + 'be recovered from the file, and it looks for the things you ask '
          + 'it to look for. It is a tool, not a guarantee, and it will '
          + 'sometimes miss something: a word its reader misread, a face at an '
          + 'angle it did not match, a detector you did not switch on.',
          'Every proposal is shown to you before anything is covered, and '
          + 'nothing is applied that you did not agree to, precisely because '
          + 'the judgement about whether a document is safe to release is '
          + 'yours and cannot be delegated to a program. Check the exported '
          + 'file before you send it. If a document matters enough to redact, '
          + 'it matters enough to read afterwards.'] },

      { h: 'No warranty',
        p: ['The tool is provided as it is, without warranty of any kind, '
          + 'express or implied, including any warranty of merchantability, '
          + 'fitness for a particular purpose, or non-infringement.',
          'To the fullest extent the law allows, we are not liable for any '
          + 'loss arising from your use of the tool — including any '
          + 'disclosure of information that a redaction failed to cover. Where '
          + 'liability cannot be excluded, it is limited to what you paid us '
          + 'in the twelve months before the claim, which for most people is '
          + 'nothing and for everybody else is a few dollars.',
          'That is a normal disclaimer, and it is also an honest description '
          + 'of the bargain: this costs a few dollars and cannot carry the '
          + 'risk of your release decision.'] },

      { h: 'What a license is',
        p: ['Documents of twenty pages or fewer are free, at any length of '
          + 'use and forever. Above twenty pages, writing the finished file '
          + 'needs a license. Everything before that step — opening, reading, '
          + 'searching, marking, reviewing, saving a draft — is free at any '
          + 'length.',
          'A license is a time-limited permission to use the export feature, not an '
          + 'account and not a subscription. There is nothing to cancel: it '
          + 'stops working when it expires. It is a string, it is checked on '
          + 'your own machine, and it will work on any machine you paste it '
          + 'into until it runs out. Keep it to yourself; sharing it is a '
          + 'breach of these terms even though nothing technical stops you.',
          'A license buys length. It does not buy a better redaction — the tool '
          + 'does exactly the same thing either way.'] },

      { h: 'Payment',
        p: ['Passes are sold by Paddle as merchant of record. Your purchase is '
          + 'a transaction with Paddle, whose own terms apply to it alongside '
          + 'these, and Paddle handles the payment, the tax and the receipt.',
          'Prices are shown before you buy and may change; a change never '
          + 'affects a license you have already bought.'] },

      { h: 'Using it properly',
        p: ['Do not use Blinded to break the law, to conceal something you are '
          + 'legally required to disclose, or to alter a document you are not '
          + 'entitled to alter. Do not attempt to interfere with the site or '
          + 'with the service that signs licenses, and do not forge a license.',
          'Since the tool runs on your machine and sends us nothing, we have '
          + 'no way to detect any of this and no interest in trying. This '
          + 'clause tells you where the line is; it is not a claim to be '
          + 'watching it.'] },

      { h: 'The source',
        p: ['The source is published under the PolyForm Noncommercial License '
          + '1.0.0. You may read it, run it yourself and change it for any '
          + 'noncommercial purpose. You may not sell it or use it '
          + 'commercially. The licence governs the source; these terms govern '
          + 'the hosted tool and any license bought here.'] },

      { h: 'Ending it',
        p: ['You can stop using the tool at any time; there is nothing to '
          + 'close and nothing of yours held anywhere. We may stop offering '
          + 'the hosted tool, in which case any unexpired license would be '
          + 'refunded on request.',
          'Because the source is published, the tool itself cannot be taken '
          + 'away from you: a copy you have run yourself keeps working '
          + 'whatever happens to this site.'] },

      { h: 'Changes',
        p: ['If these terms change, the change is visible in the '
          + 'repository’s history along with everything else. Continuing to '
          + 'use the tool after a change means accepting it.',
          'Questions: ' + CONTACT + '.'] },
    ],
  },

  {
    slug: 'refunds',
    title: 'Refunds and cancellation',
    h1: 'Refunds and cancellation',
    description: 'A full refund within ' + REFUND_HOURS + ' hours of buying a '
      + 'license, for any reason. There is no subscription to cancel.',
    sections: [
      { h: 'The rule',
        p: ['<strong>A full refund within ' + REFUND_HOURS + ' hours of '
          + 'purchase, for any reason at all.</strong> You do not have to '
          + 'explain, and you do not have to have found a fault. If the tool '
          + 'was not what you wanted, that is reason enough.',
          'Twenty pages are free precisely so that this decision can be made '
          + 'before any money changes hands: you can see exactly what the tool '
          + 'finds in your own document before you pay a thing. A license buys '
          + 'length, and nothing else changes when you have one.'] },

      { h: 'How to ask',
        p: ['Write to ' + CONTACT + ' with the receipt Paddle sent you, or the '
          + 'transaction id from it. One line is plenty.',
          'Refunds are processed by Paddle, who took the payment, and the '
          + 'money goes back to the card you paid with. How long it then takes '
          + 'to appear is up to your bank, which is usually a few working '
          + 'days.'] },

      { h: 'After the window',
        p: ['Past ' + REFUND_HOURS + ' hours we are not promising a refund, '
          + 'but ask anyway if something went wrong. A license that never worked, '
          + 'or a payment that went through and produced nothing, is our '
          + 'problem to fix whenever you notice it.'] },

      { h: 'There is nothing to cancel',
        p: ['A license is not a subscription. It is bought once, it works until '
          + 'it expires, and then it stops. Nothing recurs, nothing renews, '
          + 'and there is no account to close — so there is no cancellation '
          + 'to remember and no dark pattern to find your way out of.',
          'One honest consequence: a refunded license keeps working until it '
          + 'expires. Checking a license happens on your machine and asks us '
          + 'nothing, which is what makes it private and also what makes it '
          + 'impossible for us to withdraw. We have chosen privacy over '
          + 'control here, deliberately, and at these prices it is not a close '
          + 'call.'] },

      { h: 'If your license never arrived',
        p: ['Write to ' + CONTACT + ' with your Paddle receipt and we will '
          + 'send the license by hand. A payment that went through and left you '
          + 'with nothing is ours to fix, not yours, and it does not count '
          + 'against any window.'] },
    ],
  },
];
