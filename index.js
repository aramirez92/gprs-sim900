// Copyright 2014 Technical Machine, Inc. See the COPYRIGHT
// file at the top-level directory of this distribution.
//
// Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// http://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. This file may not be copied, modified, or distributed
// except according to those terms.

/*
At the center of Tessel's GPRS Module lies the SIM900, documentation 
for which, including a full list of commands, can be found at:
http://wm.sim.com/producten.aspx?id=1019

The full AT command manual is here: 
http://wm.sim.com/upfile/2013424141114f.pdf
*/

var util = require('util');
var EventEmitter = require('events').EventEmitter;
var Packetizer = require('./packetizer.js');
var Postmaster = require('./postmaster.js');

var DEBUG = false;  //  Debug messages to the console

// Constructor
function GPRS (hardware, baud) {
  /*
  Args
    hardware
      The Tessel port to be used for priary communication
    baud
      Override the defualt baud rate of 115200 if necessary (for software UART)
  */

  var self = this;

  baud = baud || 115200;

  self.hardware = hardware;
  self.uart = new hardware.UART({baudrate: baud});
  self.power = hardware.gpio(3).high();
  self.packetizer = new Packetizer(self.uart);
  self.packetizer.packetize();
  self.inACall = false;
  self.notificationCallbacks = {'_everyTime' : []};
  self.powered = null;
  //  The defaults are fine for most of Postmaster's args
  self.postmaster = new Postmaster(self.packetizer, ['OK', 'ERROR', '> ']);
}

util.inherits(GPRS, EventEmitter);

// Make contact with the GPRS module, emit the 'ready' event
GPRS.prototype._establishContact = function(callback, rep, reps) {
  /*
  Args
    callback
      Callback function
    rep
      How many times have we tried?
    reps
      How many times until we give up

  Callback parameters
    err
      An error
    contacted
      Reply from SIM900 module (Array of Strings) OR false if unable to contact
  */

  var self = this;
  rep = rep || 0;
  reps = reps || 5;
  var patience = 1000;
  callback = callback || function dummyCallback(err) {
    console.log(!err ? 'GPRS Module ready to command!' : 'Unable to contact GPRS Module.');
  };

  self._txrx('AT', patience, function checkIfWeContacted(err, data) {
    if (err && err.type === 'timeout') {
      //  If we time out on AT, we're likely powered off
      //  Toggle the power and try again
      self.togglePower(function tryAgainAfterToggle() {
        self._establishContact(callback, rep + 1, reps);
      });
    } else if (!err) {
      self.emit('ready');
      if (callback) {
        callback(err, data);
      }
    } else if (callback) {
      callback(err, false);
    }
  }, [['AT', '\\x00AT', '\x00AT', 'OK'], ['OK'], 1]);
};

// Make UART calls to the module
GPRS.prototype._txrx = function(message, patience, callback, alternate) {
  /*
  Every time we interact with the SIM900, it's through a series of UART calls and responses. This fucntion makes that less painful. Note that this function requires that the SIM900 be configured to echo the commands it recieves (the default) in order for it to function properly.

  Args
    message
      String you're sending, ie 'AT'
    patience
      Milliseconds until we stop listening. It's likely that the module is no longer responding to any single event if the reponse comes too much after we ping it.
    callback
      Callback function
    alternate
      An array of arrays of alternate starts and ends of reply post. Of the form [[s1, s2 ...], [e1, e2, ...]]. Used in place of traditional controls. If the third element of `alternate` is truth-y, then the values of `start` only need exist within the incoming data (good for posts with known headers but unknown bodies), as opposed to at the beginning of the packet.

 Callback parameters
    err
      Error object, if applicable
    recieved
      The reply recieved within the interval
  */

  var self = this;

  message  = message  || 'AT';
  patience = patience || 250;
  callback = callback || ( function(err, arg) {
    if (err) {
      debug('err:\n', err);
    } else {
      debug('reply:\n', arg);
    }
  });
  alternate = alternate || null;
  //  It's a virtue, but mostly the module won't work if you're impatient
  patience = Math.max(patience, 100);

  self.postmaster.send(message, patience, callback, alternate);
};

// Answer an incoming voice call
GPRS.prototype.answerCall = function(callback) {
  /*
  Args
    callback
      Callback function

  Callback parameters
    err
      Error
    data
      ['ATA', 'OK'] if all goes well
  */

  var self = this;
  self._txrx('ATA', 10000, function(err, data) {
    if (!err) {
      self.inACall = true;
    }
    callback(err, data);
  });
};

// Send a series of back-to-back messages recursively and do something with the final result. Other results, if not of the form [`messages[n]`, 'OK'] error out and pass false to the callback. The arguments `messages` and `patience` must be of the same length.
GPRS.prototype._chain = function(messages, patiences, replies, callback) {
  /*
  mesages
    An array of Strings to send as commands
  patiences
    An array of numbers; milliseconds to wait for each command to return
  replies
    An array of expected replies (arrays of strings). If any index is false-y, its reply simply must not error out.
  callback
    Callback function. Args come from the last function in the chain.

  Callback parameters
    err
      Error
    data
      What the final message command returned OR false if the replies were not as expected
  */

  var self = this;
  if (messages.length != patiences.length || messages.length != replies.length) {
    callback(new Error('Array lengths must match'), false);
  } else {
    //  A function to handle all commands before the final command
    var intermediate = function(err, data) {
      var correct = !err;
      //  If the `replies` index is truth-y, check that the actual reply exactly matches the expected reply
      if (replies[0]) {
        for (var i = 0; i < data.length; i++) {
          //  Allow start of transmission packets to be valid
          correct = correct && ([data[i], '\\x00' + data[i], '\x00' + data[i]].indexOf(replies[0][i]) > -1);
        }
      }
      self.emit('intermediate', correct);
    };
    //  Still more to do in the chain
    if (messages.length > 0) {
      var func = (messages.length === 1) ? callback:intermediate;
      self._txrx(messages[0], patiences[0], func, [[messages[0]], [replies[0][replies[0].length - 1]]]);
      //  If we have more to do before the base case, respond to the 'intermediate' event and keep going
      if (func === intermediate) {
        self.once('intermediate', function(correct) {
          if (correct) {
            self._chain(messages.slice(1), patiences.slice(1), replies.slice(1), callback);
          } else {
            self.postmaster.forceClear();
            if (callback) {
              callback(new Error('Chain broke on ' + messages[0]), false);
            }
          }
        });
      }
    }
  }
};

// Call the specified number (voice call, not data call)
GPRS.prototype.dial = function(number, callback) {
  /*
  Args
    number
      String representation of the number. Must be at least 10 digits.
    callback
      Callback function

  Callback parameters
    err
      Error, if applicable
    data
      [command echo, 'OK'] if all goes well
  */

  if (this.inACall) {
    callback(new Error('Currently in a call'), []);
  } else if (!number || String(number).length < 10) {
    callback(new Error('Number must be at least 10 digits'), []);
  } else {
    this.inACall = true;
                                  // hang up in a year
    this._txrx('ATD' + number + ';', 1000*60*60*24*365, function(err, data) {
      this.inACall = false;
      callback(err, data);
    });
  }
};

// Terminate a voice call
GPRS.prototype.hangUp = function(callback) {
  /*
  Args
    callback
      Callback function

  Callback parameters
    err
      Error
    data
      Reply upon hangup, hopefully ['ATH', 'OK']
  */

  var self = this;
  this._txrx('ATH', 100000, function(err, data) {
    self.inACall = false;
    callback(err, data);
  });
};

// Run through the notificationCallbacks every time an unsolicited message comes in and call the related functions. There is probably a better way to do this, though, so consider the function unstable and pull requests welcome.
GPRS.prototype.notify = function() {
  /*
  Args
    none - see notifyOn

  Callback parameters
    None, but err and data are passed to the callbacks in notificationCallbacks
  */

  var self = this;
  self.postmaster.on('unsolicited', function(data) {
    //  On selected unsolicited events
    Object.keys(self.notificationCallbacks).forEach(function(key) {
      if (data && data.indexOf(key) === 0) { //callThisFunction) {
        self.notificationCallbacks[key](data);
      }
    });
    //  On every unsolicited event
    self.notificationCallbacks._everyTime.forEach(function(func) {
      func(data);
    });
  });
};

// Many unsolicited events are very useful to the user, such as when an SMS is received or a call is pending. There is probably a better way to do this, though, so consider the function unstable and pull requests welcome.
GPRS.prototype.notifyOn = function(pairs, everyTime) {
  /*
  Args
    pairs
      An Object which maps unsolicited message header Strings (e.g. '+CMT' = text message recieved) to callback functions.
    everyTime
      An Array of functions to call for every unsolicited message

  Callback parameters
    None, but the given functions in pairs should accept:
      data
        The text from the unsolicited packet
  */

  var self = this;
  if (Object.keys(self.notificationCallbacks).length < 2) {
    //  This is the first time this was called, you should start notifying
    self.notify();
  }
  Object.keys(pairs).forEach(function(newKey) {
    //  Note that this overwrites whatever may have been there
    self.notificationCallbacks[newKey] = pairs[newKey];
  });
  if (everyTime) {
    everyTime.forEach(function(newKey) {
      //  Note that this overwrites whatever may have been there
      self.notificationCallbacks._everyTime.push(newKey);
    });
  }
};

// Read the specified SMS. You'll want to parse the module's unsolicited packet to pull out the specific SMS number. Note that these numbers are nonvolatile and associated with the SIM card. 
GPRS.prototype.readSMS = function(index, mode, callback) {
  /*
  Args - two possibilities
    index
      The index of the message to read. Note that the SIM900 is 1-indexed, not 0-indexed.
    mode
      0 - Mark the message as read
      1 - Do not chage the status of the message
    callback
      Callback function

  Callback parameters
    err
      Error
    message
      An array with
        0 - Command echo
        1 - Message information (read state, soure number, date, etc.)
        2 - Message text
        3 - 'OK'
      if successful
  */

  this._txrx('AT+CMGR=' + index + ',' + mode, 10000, callback);
};

// Send an SMS to the specified number
GPRS.prototype.sendSMS = function(number, message, callback) {
  /*
  Args
    number
      String representation of the number. Must be at least 10 digits.
    message
      String to send
    callback
      Callback function

  Callback parameters
    err
      Error
    success
      Did it send properly? If yes, get back the ID number of the text in an array; if not, the error and -1 as the ID.
  */

  if (!number || number.length < 10) {
    callback(new Error('Did not specify a 10+ digit number'), null);
  } else {
    var self = this;
    message = message || 'text from a Tessel';
    var commands  = ['AT+CMGF=1', 'AT+CMGS="' + number + '"', message];
    var patiences = [2000, 5000, 5000];
    var replies = [['AT+CMGF=1', 'OK'], ['AT+CMGS="' + number + '"', '> '], [message, '> ']];

    self._chain(commands, patiences, replies, function(errr, data) {
      //  manually check the last one
      var correct = !errr && data[0] == message && data[1] == '> ';
      var id = -1;
      var err = errr || new Error('Unable to send SMS');
      if (correct) {
        self._txrx(new Buffer([0x1a]), 10000, function(err, data) {
          if (data[0].indexOf('+CMGS: ') === 0 && data[1] == 'OK') {
            //  message sent!
            id = parseInt(data[0].slice(7), 10);
            err = null;
          }
          if (callback) {
            callback(err, [id]);
          }
        }, [['+CMGS: ', 'ERROR'], ['OK', 'ERROR'], 1]);
      } else if (callback) {
        callback(err, [id]);
      }
    });
  }
};

// Turn the module on or off by switching the power button (G3) electronically
GPRS.prototype.togglePower = function(callback) {
  var self = this;
  debug('toggling power...');
  self.power.high();
  setTimeout(function() {
    self.power.low();
    setTimeout(function() {
      self.power.high();
      setTimeout(function() {
        self.emit('powerToggled');
        debug('done toggling power');
        if (callback) {
          callback();
        }
      }, 5000);
    }, 1500);
  }, 100);
};

// Connect the GPRS module and establish contact with the SIM900
function use(hardware, baud, callback) {
  /*
  Args
    hardware
      The Tessel port to use for the main GPRS hardware
    baud
      Alternate baud rate for the UART
    callback
      Callback frunction for once the module is set up

    Callback parameters
      err
        Error, if any, while connecting. Passes null if successful.
  */

  var radio = new GPRS(hardware, baud);
  radio._establishContact(callback);
  return radio;
}

function debug (thing) {
  if (DEBUG) {
    console.log(thing);
  }
}

module.exports.GPRS = GPRS;
module.exports.use = use;
