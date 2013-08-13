'use strict';

var CallsHandler = (function callsHandler() {
  var COMMS_APP_ORIGIN = 'app://communications.gaiamobile.org';

  // Changing this will probably require markup changes
  var CALLS_LIMIT = 2;

  var handledCalls = [];
  var telephony = window.navigator.mozTelephony;
  telephony.oncallschanged = onCallsChanged;

  var settings = window.navigator.mozSettings;

  var displayed = false;
  var closing = false;
  var animating = false;
  var ringing = false;
  var busyNotificationLock = false;

  /* === Settings === */
  var activePhoneSound = null;
  SettingsListener.observe('audio.volume.notification', 7, function(value) {
    activePhoneSound = !!value;
    if (ringing && activePhoneSound) {
      ringtonePlayer.play();
    }
  });

  var phoneSoundURL = new SettingsURL();
  SettingsListener.observe('dialer.ringtone', '', function(value) {
    ringtonePlayer.pause();
    ringtonePlayer.src = phoneSoundURL.set(value);

    if (ringing && activePhoneSound) {
      ringtonePlayer.play();
    }
  });

  // Setting up the SimplePhoneMatcher
  var conn = window.navigator.mozMobileConnection;
  if (conn && conn.voice && conn.voice.network && conn.voice.network.mcc) {
    SimplePhoneMatcher.mcc = conn.voice.network.mcc;
  }

  var ringtonePlayer = new Audio();
  ringtonePlayer.mozAudioChannelType = 'ringer';
  ringtonePlayer.src = phoneSoundURL.get();
  ringtonePlayer.loop = true;

  var activateVibration = null;
  SettingsListener.observe('vibration.enabled', true, function(value) {
    activateVibration = !!value;
  });

  var screenLock;

  /* === Setup === */
  function setup() {
    if (telephony) {
      // Somehow the muted property appears to true after initialization.
      // Set it to false.
      telephony.muted = false;
    }

    postToMainWindow('ready');
  }

  function postToMainWindow(data) {
    if (window.opener) {
      window.opener.postMessage(data, COMMS_APP_ORIGIN);
    }
  }

  /* === Handled calls === */
  var highPriorityWakeLock = null;
  function onCallsChanged() {
    // Acquire or release the high-priority wake lock, as necessary.  This
    // (mostly) prevents this process from being killed while we're on a call.
    if (!highPriorityWakeLock && telephony.calls.length > 0) {
      highPriorityWakeLock = navigator.requestWakeLock('high-priority');
    }
    if (highPriorityWakeLock && telephony.calls.length == 0) {
      highPriorityWakeLock.unlock();
      highPriorityWakeLock = null;
    }

    // Adding any new calls to handledCalls
    telephony.calls.forEach(function callIterator(call) {
      var alreadyAdded = handledCalls.some(function hcIterator(hc) {
        return (hc.call == call);
      });

      if (!alreadyAdded) {
        addCall(call);
      }
    });

    // Removing any ended calls to handledCalls
    handledCalls.forEach(function handledCallIterator(hc, index) {
      var stillHere = telephony.calls.some(function hcIterator(call) {
        return (call == hc.call);
      });

      if (!stillHere) {
        removeCall(index);
      }
    });

    // Letting the layout know how many calls we're handling
    if (handledCalls.length === 0) {
      exitCallScreen(false);
    } else {
      CallScreen.callsCount = handledCalls.length;
      if (!displayed && !closing) {
        toggleScreen();
      }
    }
  }

  function addCall(call) {
    busyNotificationLock = false;
    // Once we already have 1 call, we need to care about incoming
    // calls and insert new dialing calls.
    if (handledCalls.length &&
      (call.state != 'incoming') && (call.state != 'dialing')) {
      return;
    }

    // No more room
    if (handledCalls.length >= CALLS_LIMIT) {
      new HandledCall(call);
      call.hangUp();
      return;
    }

    // First incoming or outgoing call, reset mute and speaker.
    if (handledCalls.length == 0) {
      CallScreen.unmute();
      CallScreen.turnSpeakerOff();
    }

    // Find an available node for displaying the call
    var node = CallScreen.calls.querySelector('.call[data-occupied="false"]');
    var hc = new HandledCall(call, node);
    handledCalls.push(hc);

    if (call.state === 'incoming') {
      call.addEventListener('statechange', function callStateChange() {
        call.removeEventListener('statechange', callStateChange);
        // The call wasn't picked up
        if (call.state == 'disconnected') {
          var callInfo = {
            type: 'notification',
            number: call.number
          };
          postToMainWindow(callInfo);
        }
      });

      // This is the initial incoming call, need to ring !
      if (handledCalls.length === 1) {
        handleFirstIncoming(call);
      }
    }

    if (handledCalls.length > 1) {
      // New incoming call, signaling the user.
      if (call.state === 'incoming') {
        handleCallWaiting(call);

      // User performed another outgoing call. show its status.
      } else {
        hc.show();
      }
    } else {
      if (window.location.hash === '#locked' &&
          (call.state == 'incoming')) {
        CallScreen.render('incoming-locked');
      } else {
        CallScreen.render(call.state);
      }
    }
  }

  function removeCall(index) {
    var removedCall = handledCalls[index];
    handledCalls.splice(index, 1);

    if (handledCalls.length > 0) {
      // Only hiding the call if we have another one to display
      removedCall.hide();
      CallScreen.hideIncoming();

      var remainingCall = handledCalls[0];
      if (remainingCall.call.state == 'incoming') {
        // The active call ended, showing the incoming call
        remainingCall.show();

        // This is the difference between an endAndAnswer() and
        // the active call being disconnected while a call is waiting
        setTimeout(function nextTick() {
          if (remainingCall.call.state == 'incoming') {
            CallScreen.render('incoming');
          }
        });

        return;
      }

      // The incoming call was rejected, resuming...
      remainingCall.call.resume();
      return;
    }

    exitCallScreen(true);
  }

  function handleFirstIncoming(call) {
    var vibrateInterval = 0;
    if (activateVibration != false) {
      vibrateInterval = window.setInterval(function vibrate() {
        // Wait for the setting value to return before starting a vibration.
        if ('vibrate' in navigator && activateVibration) {
          navigator.vibrate([200]);
        }
      }, 600);
    }

    if (activePhoneSound == true) {
      ringtonePlayer.play();
      ringing = true;
    } else if (activePhoneSound == null) {
      // Let's wait for the setting to return before playing any sound.
      ringing = true;
    }

    screenLock = navigator.requestWakeLock('screen');

    call.addEventListener('statechange', function callStateChange() {
      call.removeEventListener('statechange', callStateChange);

      ringtonePlayer.pause();
      ringing = false;

      window.clearInterval(vibrateInterval);

      if (screenLock) {
        screenLock.unlock();
        screenLock = null;
      }
    });
  }

  function handleCallWaiting(call) {
    LazyL10n.get(function localized(_) {
      var number = call.number;

      if (!number) {
        CallScreen.incomingNumber.textContent = _('withheld-number');
        return;
      }

      Contacts.findByNumber(number, function lookupContact(contact) {
        if (contact && contact.name) {
          CallScreen.incomingNumber.textContent = contact.name;
          return;
        }

        CallScreen.incomingNumber.textContent = number;
      });
    });

    CallScreen.showIncoming();

    // ANSI call waiting tone for a 10 sec window
    var sequence = [[440, 440, 100],
                    [0, 0, 100],
                    [440, 440, 100]];
    var toneInterval = window.setInterval(function playTone() {
      TonePlayer.playSequence(sequence);
    }, 10000);
    TonePlayer.playSequence(sequence);

    call.addEventListener('statechange', function callStateChange() {
      call.removeEventListener('statechange', callStateChange);
      window.clearInterval(toneInterval);
    });
  }

  /* === Call Screen === */
  function toggleScreen() {
    displayed = !displayed;
    animating = true;

    var callScreen = CallScreen.screen;
    callScreen.classList.toggle('displayed');

    callScreen.addEventListener('transitionend', function trWait() {
      callScreen.removeEventListener('transitionend', trWait);

      animating = false;

      // We did animate the call screen off the viewport
      // now closing the window.
      if (!displayed) {
        closeWindow();
      }
    });
  }

  function updateKeypadEnabled() {
    if (telephony.active) {
      CallScreen.enableKeypad();
    } else {
      CallScreen.disableKeypad();
    }
  }

  function exitCallScreen(animate) {
    if (closing || busyNotificationLock) {
      return;
    }

    closing = true;

    postToMainWindow('closing');

    if (Swiper) {
      Swiper.setElasticEnabled(false);
    }

    // If the screen is not displayed yet we close the window directly
    if (animate && !animating && displayed) {
      toggleScreen();
    } else {
      closeWindow();
    }
  }

  function closeWindow() {
    window.close();
  }

  /* Handle commands send to the callscreen via postmessage */
  function handleCommand(evt) {
    if (evt.origin !== COMMS_APP_ORIGIN) {
      return;
    }
    var message = evt.data;
    if (!message) {
      return;
    }

    // Currently managing three kinds of commands:
    // BT: bluetooth
    // HS: headset
    // * : general cases, not specific to hardware control
    switch (message.type) {
      case 'BT':
        handleBTCommand(message.command);
        break;
      case 'HS':
        handleHSCommand(message.command);
        break;
      case '*':
        handleGeneralCommand(message.command);
        break;
    }
  }

  /* === Bluetooth Headset support ===*/
  function handleBTCommand(message) {
    switch (message) {
      case 'CHUP':
        end();
        break;
      case 'ATA':
        answer();
        break;
      case 'CHLD=1':
        endAndAnswer();
        break;
      case 'CHLD=2':
        if (telephony.calls.length === 1) {
          holdOrResumeSingleCall();
        } else {
          holdAndAnswer();
        }
        break;
      case 'CHLD=0':
        hangupWaitingCalls();
        break;
      default:
        var partialCommand = message.substring(0, 3);
        if (partialCommand === 'VTS') {
          KeypadManager.press(message.substring(4));
        }
        break;
    }
  }

  var lastHeadsetPress = 0;

  function handleHSCommand(message) {
    /**
     * See bug 853132: plugging / unplugging some headphones might send a
     * 'headset-button-press' / 'headset-button-release' message
     * => if these two events happen in the same second, it's a click;
     * => if these two events are too distant, ignore them.
     */
    switch (message) {
      case 'headset-button-press':
        lastHeadsetPress = Date.now();
        return;
        break;
      case 'headset-button-release':
        if ((Date.now() - lastHeadsetPress) > 1000)
          return;
        break;
      default:
        return;
    }

    if (telephony.active) {
      end();
    } else if (handledCalls.length > 1) {
      holdAndAnswer();
    } else {
      answer();
    }
  }

  function handleGeneralCommand(message) {
    // Calls might be ended before callscreen is completely loaded or we
    // register 'callschanged' event. To avoid leaving callscreen stuck open,
    // we use a simple postMessage protocol to know when the call screen is
    // supposed to be closed, in addition to 'callschanged' event.
    if (message == 'exitCallScreen') {
      exitCallScreen(false);
    }
  }

  window.addEventListener('message', handleCommand);

  /* === User Actions === */
  function answer() {
    // We should always have only 1 call here
    if (!handledCalls.length) {
      return;
    }

    handledCalls[0].call.answer();

    if (CallScreen.screen.dataset.layout === 'incoming-locked') {
      CallScreen.mainContainer.style.backgroundImage =
        CallScreen.lockedContactPhoto.style.backgroundImage;
    }

    CallScreen.render('connected');
  }

  function holdAndAnswer() {
    var callToAnswerIndex = handledCalls.length - 1;
    var callToHoldIndex = callToAnswerIndex - 1;
    var callToAnswer = handledCalls[callToAnswerIndex].call;

    if (handledCalls[callToHoldIndex]) {
      handledCalls[callToHoldIndex].call.hold();
    }
    callToAnswer.answer();

    CallScreen.hideIncoming();
  }

  function endAndAnswer() {
    var callToAnswerIndex = handledCalls.length - 1;
    var callToEndIndex = callToAnswerIndex - 1;
    var callToAnswer = handledCalls[callToAnswerIndex].call;

    if (handledCalls[callToEndIndex]) {
      var callToEnd = handledCalls[callToEndIndex].call;
      callToEnd.addEventListener('disconnected', function disconnected() {
        callToEnd.removeEventListener('disconnected', disconnected);
        callToAnswer.answer();
      });
      callToEnd.hangUp();
    }

    CallScreen.hideIncoming();
  }

  function toggleCalls() {
    if (CallScreen.incomingContainer.classList.contains('displayed')) {
      return;
    }

    if (handledCalls.length < 2) {

      // Putting a call on Hold when there are no other
      // calls in progress has been disabled until a less
      // accidental user-interface is implemented.
      // See bug 894232 and bug 882056 for more background.
      // We can now hold a call only from BT devices.
      if (!telephony.active) {
        holdOrResumeSingleCall();
      }
      return;
    }

    telephony.active.hold();
  }

  function holdOrResumeSingleCall() {
    if (handledCalls.length !== 1) {
      return;
    }

    if (telephony.active) {
      telephony.active.hold();
      CallScreen.render('connected-hold');
    } else {
      telephony.calls[0].resume();
      CallScreen.render('connected');
    }
  }

  // Hang up the held call or the second incomming call
  function hangupWaitingCalls() {
    handledCalls.forEach(function(handledCall) {
      var callState = handledCall.call.state;
      if (callState === 'held' ||
        (callState === 'incoming' && handledCalls.length > 1)) {
        handledCall.call.hangUp();
      }
    });
  }

  function ignore() {
    var ignoreIndex = handledCalls.length - 1;
    handledCalls[ignoreIndex].call.hangUp();

    CallScreen.hideIncoming();
  }

  function end() {
    busyNotificationLock = false;
    // If there is an active call we end this one
    if (telephony.active) {
      telephony.active.hangUp();
      return;
    }

    // If not we're rejecting the last incoming call
    if (!handledCalls.length) {
      exitCallScreen(true);
      return;
    }

    var lastCallIndex = handledCalls.length - 1;
    handledCalls[lastCallIndex].call.hangUp();
  }

  function unmute() {
    telephony.muted = false;
  }

  function turnSpeakerOn() {
    if (!telephony.speakerEnabled) {
      telephony.speakerEnabled = true;
      if (settings) {
        settings.createLock().set({'telephony.speaker.enabled': true});
      }
    }
  }

  function turnSpeakerOff() {
    if (telephony.speakerEnabled) {
      telephony.speakerEnabled = false;
      if (settings) {
        settings.createLock().set({'telephony.speaker.enabled': false});
      }
    }
  }

  function toggleMute() {
    telephony.muted = !telephony.muted;
  }

  function toggleSpeaker() {
    if (telephony.speakerEnabled)
      turnSpeakerOff();
    else
      turnSpeakerOn();
  }

  /* === Recents management === */
  function addRecentEntry(entry) {
    var message = {
      type: 'recent',
      entry: entry
    };
    postToMainWindow(message);
  }

  function notifyBusyLine() {
    busyNotificationLock = true;
    // ANSI call waiting tone for a 3 seconds window.
    var sequence = [[480, 620, 500],
                    [0, 0, 500],
                    [480, 620, 500],
                    [0, 0, 500],
                    [480, 620, 500],
                    [0, 0, 500]];
    TonePlayer.playSequence(sequence);
    setTimeout(function busyLineStopped() {
      if (handledCalls.length === 0) {
        busyNotificationLock = false;
        exitCallScreen(true);
      }
    }, 3000);
  }

  function activeCall() {
    var telephonyActiveCall = telephony.active;
    var activeCall = null;
    for (var i = 0; i < handledCalls.length; i++) {
      var handledCall = handledCalls[i];
      if (telephonyActiveCall === handledCall.call) {
        activeCall = handledCall;
        break;
      }
    }
    return activeCall;
  }

  return {
    setup: setup,

    answer: answer,
    holdAndAnswer: holdAndAnswer,
    endAndAnswer: endAndAnswer,
    toggleCalls: toggleCalls,
    ignore: ignore,
    end: end,
    updateKeypadEnabled: updateKeypadEnabled,
    toggleMute: toggleMute,
    toggleSpeaker: toggleSpeaker,
    unmute: unmute,
    turnSpeakerOn: turnSpeakerOn,
    turnSpeakerOff: turnSpeakerOff,

    addRecentEntry: addRecentEntry,

    notifyBusyLine: notifyBusyLine,
    activeCall: activeCall
  };
})();

window.addEventListener('load', function callSetup(evt) {
  window.removeEventListener('load', callSetup);

  CallsHandler.setup();
  CallScreen.init();
  KeypadManager.init(true);
});