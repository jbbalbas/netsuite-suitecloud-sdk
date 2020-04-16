/*
** Copyright (c) 2019 Oracle and/or its affiliates.  All rights reserved.
** Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl.
*/
'use strict';
import BaseCommandGenerator from './BaseCommandGenerator';
import LocalCommand from '@oracle/suitecloud-cli-localserver-command';

import { COLORS } from '../loggers/LoggerConstants';
import { COMMAND_LOCAL } from './../services/TranslationKeys';
import { NodeTranslationService } from './../services/NodeTranslationService';
import { LocalCommandOptions } from '../../types/CommandOptions';
import { Prompt } from '../../types/Prompt';
import FileSystemService from '../services/FileSystemService';
import { ActionResultBuilder } from './actionresult/ActionResult';

export default class LocalServerCommandGenerator extends BaseCommandGenerator<LocalCommandOptions, any> {
	local: any;
	protected actionResultBuilder = new ActionResultBuilder();

	constructor(options: LocalCommandOptions) {

		super(options);
		options.filesystem = FileSystemService;
		options.colors = COLORS;
		options.translation = [NodeTranslationService, COMMAND_LOCAL];

		this.local = new LocalCommand(options);
	}

	public getCommandQuestions(prompt: Prompt<any>) {
		this.local.initialize();
		return this.local.getCommandQuestions(prompt);
	}

	public executeAction(answers: any) {
		this.local.initialize();
		// TODO: ensure this.local.executeAction returns an ActionResult
		return this.local.executeAction(answers);
	}
};
