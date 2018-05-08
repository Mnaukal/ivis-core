'use strict';

import React, { Component } from 'react';
import PropTypes from 'prop-types';
import { translate } from 'react-i18next';
import { requiresAuthenticatedUser, withPageHelpers } from '../lib/page';
import { withErrorHandling, withAsyncErrorHandler } from '../lib/error-handling';
import {
    withForm, Form, FormSendMethod, TableSelect, ButtonRow, Button
} from '../lib/form';
import { Table } from '../lib/table';
import axios from '../lib/axios';
import {Panel} from "../lib/panel";
import {getUrl} from "../lib/urls";

@translate()
@withForm
@withPageHelpers
@withErrorHandling
@requiresAuthenticatedUser
export default class Share extends Component {
    constructor(props) {
        super(props);

        this.initForm();
    }

    static propTypes = {
        title: PropTypes.string,
        entity: PropTypes.object,
        entityTypeId: PropTypes.string
    }

    @withAsyncErrorHandler
    async deleteShare(userId) {
        const data = {
            entityTypeId: this.props.entityTypeId,
            entityId: this.props.entity.id,
            userId
        };

        await axios.put(getUrl('rest/shares'), data);
        this.sharesTable.refresh();
        this.usersTableSelect.refresh();
    }

    clearShareFields() {
        this.populateFormValues({
            entityTypeId: this.props.entityTypeId,
            entityId: this.props.entity.id,
            userId: null,
            role: null
        });
    }

    componentDidMount() {
        this.clearShareFields();
    }

    localValidateFormValues(state) {
        const t = this.props.t;

        if (!state.getIn(['userId', 'value'])) {
            state.setIn(['userId', 'error'], t('User must not be empty'));
        } else {
            state.setIn(['userId', 'error'], null);
        }

        if (!state.getIn(['role', 'value'])) {
            state.setIn(['role', 'error'], t('Role must be selected'));
        } else {
            state.setIn(['role', 'error'], null);
        }
    }

    async submitHandler() {
        const t = this.props.t;

        this.disableForm();
        this.setFormStatusMessage('info', t('Saving ...'));

        const submitSuccessful = await this.validateAndSendFormValuesToURL(FormSendMethod.PUT, 'rest/shares');

        if (submitSuccessful) {
            this.hideFormValidation();
            this.clearShareFields();
            this.enableForm();

            this.clearFormStatusMessage();
            this.sharesTable.refresh();
            this.usersTableSelect.refresh();

        } else {
            this.enableForm();
            this.setFormStatusMessage('warning', t('There are errors in the form. Please fix them and try again.'));
        }
    }

    render() {
        const t = this.props.t;
        
        const sharesColumns = [];
        sharesColumns.push({ data: 0, title: t('Username') });
        sharesColumns.push({ data: 1, title: t('Name') });
        sharesColumns.push({ data: 2, title: t('Role') });

        sharesColumns.push({
            actions: data => {
                const actions = [];
                const autoGenerated = data[4];

                if (!autoGenerated) {
                    actions.push({
                        label: <Icon icon="remove" title={t('Remove')} />,
                        action: () => this.deleteShare(data[3])
                    });
                }

                return actions;
            }
            ,
            title: t('Action')
        })

        let usersLabelIndex = 1;
        const usersColumns = [
            { data: 0, title: t('#') },
            { data: 1, title: t('Username') },
        ];

        usersColumns.push({ data: 2, title: t('Full Name') });
        usersLabelIndex = 2;

        const rolesColumns = [
            { data: 1, title: t('Name') },
            { data: 2, title: t('Description') },
        ];

        return (
            <Panel title={this.props.title}>
                <h3 className="legend">{t('Add User')}</h3>
                <Form stateOwner={this} onSubmitAsync={::this.submitHandler}>
                    <TableSelect ref={node => this.usersTableSelect = node} id="userId" label={t('User')} withHeader dropdown dataUrl={`rest/shares-unassigned-users-table/${this.props.entityTypeId}/${this.props.entity.id}`} columns={usersColumns} selectionLabelIndex={usersLabelIndex}/>
                    <TableSelect id="role" label={t('Role')} withHeader dropdown dataUrl={`rest/shares-roles-table/${this.props.entityTypeId}`} columns={rolesColumns} selectionLabelIndex={1}/>

                <ButtonRow>
                    <Button type="submit" className="btn-primary" icon="ok" label={t('Share')} />
                </ButtonRow>
                </Form>

                <hr />
                <h3 className="legend">{t('Existing Users')}</h3>

                <Table ref={node => this.sharesTable = node} withHeader dataUrl={`rest/shares-table-by-entity/${this.props.entityTypeId}/${this.props.entity.id}`} columns={sharesColumns} />
            </Panel>
        );
    }
}
